/*
 * Copyright (c) 2014 Jesse van den Kieboom. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *    * Redistributions of source code must retain the above copyright
 *      notice, this list of conditions and the following disclaimer.
 *    * Redistributions in binary form must reproduce the above
 *      copyright notice, this list of conditions and the following disclaimer
 *      in the documentation and/or other materials provided with the
 *      distribution.
 *    * Neither the name of Google Inc. nor the names of its
 *      contributors may be used to endorse or promote products derived from
 *      this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

var Editor = require('./editor');
var Document = require('./document');
var ui = require('../ui/ui');
var glsl = require('../glsl/glsl');
var Store = require('./store');
var Renderer = require('./renderer');
var Signals = require('../signals/signals');
var marked = require('../vendor/marked');

require('./js-mode');

function App() {
    Signals.call(this);

    this.document = null;

    this._on_document_changed = this.register_signal('notify::document');
    this._lastFocus = null;

    window.addEventListener('error', (function(e) {
        var error = e.error;

        if (error.originalStack) {
            this._handle_js_error(error);

            e.preventDefault();
            e.stopPropagation();
            return true;
        }
    }).bind(this));

    if (document.readyState === 'complete') {
        this._init();
    } else {
        document.addEventListener('DOMContentLoaded', this._init.bind(this));
    }
}

App.prototype = Object.create(Signals.prototype);
App.prototype.constructor = App;

App.prototype.find = function(elems) {
    var ret = {};

    for (var k in elems) {
        ret[k] = document.querySelector(elems[k]);
    }

    return ret;
}

App.prototype.new_document = function() {
    var doc = new Document(this);

    this._load_doc(doc);
    this._save_current_doc();
}

App.prototype.load_document = function(doc) {
    if (doc === null) {
        this.new_document();
        return;
    }

    if (!Document.prototype.isPrototypeOf(doc)) {
        doc = Document.deserialize(doc);
    }

    this._load_doc(doc);
}

App.prototype._extract_js_error_loc = function(e) {
    var stack;

    stack = e.originalStack || e.stack;
    var lines = stack.split('\n');

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        // Chrome
        var anon = /, <anonymous>:([0-9]+):([0-9]+)\)$/;
        var m = line.match(anon);

        if (m) {
            return {
                line: parseInt(m[1]) - 1,
                column: parseInt(m[2])
            }
        }

        // Firefox
        var func = /> Function:([0-9]+):([0-9]+)$/
        m = line.match(func);

        if (m) {
            return {
                line: parseInt(m[1]),
                column: parseInt(m[2])
            }
        }
    }

    return null;
}

App.prototype._handle_js_error = function(e) {
    var message = e.message;
    var loc = this._extract_js_error_loc(e);

    if (loc) {
        this.js_editor.runtime_error({
            message: message,
            location: loc
        });
    } else {
        console.error(e.stack);
    }
}

App.prototype._update_renderer = function() {
    var ret = this.renderer.update(this.document);

    if (typeof ret === 'undefined') {
        var c = {
            c: this.renderer.context,
            Math: Math
        };

        if (this.renderer.program) {
            c.this = this.renderer.program;
        }

        this.js_editor.completionContext(c);

        for (var i = 0; i < this.document.programs.length; i++) {
            var p = this.document.programs[i];
            p.error(null);
        }
    } else {
        var e = null;

        if (ret.js.extensions !== null) {
            e = ret.js.extensions;
        } else if (ret.js.init !== null) {
            e = ret.js.init;
        } else if (ret.js.run !== null) {
            e = ret.js.run;
        }

        if (e !== null) {
            this._handle_js_error(e);
        }

        var progs = null;

        for (var i = 0; i < this.document.programs.length; i++) {
            var p = this.document.programs[i];
            var name = p.name();

            if (ret.programs !== null && name in ret.programs) {
                p.error(ret.programs[name]);
            } else {
                p.error(null);
            }
        }
    }
}

App.prototype._update_editors = function() {
    var up = {};

    var names = ['vertex', 'fragment', 'js'];

    for (var i = 0; i < names.length; i++) {
        var editor = this[names[i] + '_editor'];

        up[names[i]] = {
            data: editor.value(),
            history: editor.history()
        };
    }

    this._update_document_by(up);
}

App.prototype._on_document_before_active_program_changed = function() {
    this._update_editors();
}

App.prototype._on_document_active_program_changed = function() {
    var prg = this.document.active_program();

    var loading = this._loading;
    this._loading = true;

    this.vertex_editor.value(prg.vertex.data);
    this.vertex_editor.history(prg.vertex.history);

    this.fragment_editor.value(prg.fragment.data);
    this.fragment_editor.history(prg.fragment.history);

    this._loading = loading;
    this._save_current_doc_with_delay();
}

App.prototype._on_document_title_changed = function() {
    this.title.textContent = this.document.title;
}

App.prototype._load_doc_real = function(doc) {
    if (this.document !== null) {
        this.document.off('notify-before::active-program', this._on_document_before_active_program_changed, this);
        this.document.off('notify::active-program', this._on_document_active_program_changed, this);
        this.document.off('notify::title', this._on_document_title_changed, this);

        this.document.off('changed', this._on_document_changed, this);
    }

    this.document = doc;

    this._on_document_active_program_changed();

    this.js_editor.value(doc.js.data);
    this.js_editor.history(doc.js.history);

    if (doc.active_editor !== null) {
        var editor = null;

        switch (doc.active_editor.name) {
        case 'js':
            editor = this.js_editor;
            break;
        case 'vertex':
            editor = this.vertex_editor;
            break;
        case 'fragment':
            editor = this.fragment_editor;
            break;
        }

        if (editor !== null) {
            editor.focus();
            editor.cursor(doc.active_editor.cursor);
        }
    } else {
        this.canvas.focus();
    }

    this.title.textContent = doc.title;

    if (doc.state && doc.state.panels) {
        for (var k in doc.state.panels) {
            var p = doc.state.panels[k];
            this.panels[k].position(p.position);
        }

        this._update_canvas_size();
    }

    this._loading = false;
    this._update_renderer();

    this.document.on('notify-before::active-program', this._on_document_before_active_program_changed, this);
    this.document.on('notify::active-program', this._on_document_active_program_changed, this);
    this.document.on('notify::title', this._on_document_title_changed, this);
    this.document.on('changed', this._on_document_has_changed, this);

    this._on_document_changed();

    this.content.classList.add('loaded');
    this.content.classList.remove('loading');
}

App.prototype._load_doc = function(doc) {
    this._loading = true;

    if (this.document !== null) {
        this.content.classList.remove('loaded');
        this.content.classList.add('loading');

        setTimeout((function() {
            this._load_doc_real(doc);
        }).bind(this), 200);
    } else {
        this._load_doc_real(doc);
    }
}

App.prototype._on_document_has_changed = function(doc, opts) {
    this._save_current_doc_with_delay((function() {
        if ('vertex' in opts || 'fragment' in opts || 'js' in opts || 'programs' in opts) {
            this._update_renderer();
        }
    }).bind(this));
}

App.prototype._serialize_document = function(doc) {
    var ret = doc.serialize();

    ret.state = {
        panels: {}
    };

    for (var k in this.panels) {
        ret.state.panels[k] = {
            position: this.panels[k].position()
        };
    }

    return ret;
}

App.prototype._save_doc = function(doc, cb) {
    this._store.save(this._serialize_document(doc), function(store, retdoc) {
        if (retdoc !== null) {
            doc.id = retdoc.id;
        }

        if (typeof cb === 'function') {
            cb(retdoc !== null);
        }
    });
}

App.prototype._save_current_doc = function(cb) {
    this._save_doc(this.document, cb);
}

App.prototype._save_current_doc_with_delay = function(cb) {
    if (this._save_timeout !== 0) {
        clearTimeout(this._save_timeout);
        this._save_timeout = 0;
    }

    this._save_timeout = setTimeout((function() {
        this._save_timeout = 0;
        this._save_current_doc(cb);
    }).bind(this), 500);
}

App.prototype._update_canvas_size = function() {
    this.canvas.width = this.canvas.clientWidth;
    this.canvas.height = this.canvas.clientHeight;
}

App.prototype._init_panels = function() {
    var panels = document.querySelectorAll('.panel');

    this.panels = {};

    for (var i = 0; i < panels.length; i++) {
        var p = panels[i];

        this.panels[p.id] = new ui.Panel(p);
    }

    this.panels['panel-programs'].on('resized', (function() {
        this.vertex_editor.editor.refresh();
        this.fragment_editor.editor.refresh();
        this.js_editor.editor.refresh();
        this._update_canvas_size();
    }).bind(this));

    this.panels['panel-main'].on('resized', (function() {
        this.vertex_editor.editor.refresh();
        this.fragment_editor.editor.refresh();
        this.js_editor.editor.refresh();
        this._update_canvas_size();
    }).bind(this));

    this.panels['panel-program'].on('resized', (function() {
        this.vertex_editor.editor.refresh();
        this.fragment_editor.editor.refresh();
    }).bind(this));

    this.panels['panel-js'].on('resized', (function() {
        this.js_editor.editor.refresh();
        this._update_canvas_size();
    }).bind(this));
}

App.prototype._update_document_by = function(opts) {
    if (this._loading) {
        return;
    }

    this.document.update(opts);
}

App.prototype._update_document = function(name, editor) {
    if (this._loading) {
        return;
    }

    var up = {};

    up[name] = {
        data: editor.value(),
        history: editor.history()
    };

    this._update_document_by(up);
}

App.prototype._init_canvas = function() {
    this.canvas = document.getElementById('view');

    var t = this.canvas.parentElement.querySelector('.editor-title');

    this.canvas.addEventListener('focus', (function(title) {
        t.classList.add('hidden');
        this._update_document_by({active_editor: null});

        this._lastFocus = this.canvas;
    }).bind(this, t));

    this.canvas.addEventListener('blur', (function(title) {
        t.classList.remove('hidden');
    }).bind(this, t));

    window.addEventListener('resize', (function(e) {
        this._update_canvas_size();
    }).bind(this));

    this.renderer = new Renderer(this.canvas, document.getElementById('content'));

    this.renderer.on('notify::first-frame', (function(r, frame) {
        this.document.update({
            screenshot: frame
        });
    }).bind(this));

    this.renderer.on('notify::fullscreen', (function() {
        this._update_canvas_size();
    }).bind(this));

    this.renderer.on('error', (function(r, e) {
        this._handle_js_error(e);
    }).bind(this));
}

App.prototype._init_editors = function() {
    var elems = this.find({
        vertex_editor: '#vertex-editor',
        fragment_editor: '#fragment-editor',
        js_editor: '#js-editor'
    });

    var opts = {
        theme: 'default webgl-play',
        indentUnit: 4,
        lineNumbers: true,
        rulers: [78]
    };

    for (var k in elems) {
        this[k] = CodeMirror(elems[k], opts);

        var p = elems[k].parentElement;
        var t = p.querySelector('.editor-title');

        this[k].on('focus', (function(title, k) {
            var n = k.slice(0, k.indexOf('_'));

            title.classList.add('hidden');

            this._update_document_by({
                active_editor: {
                    name: n,
                    cursor: this[k].cursor()
                }
            });

            this._lastFocus = elems[k];
        }).bind(this, t, k));

        this[k].on('blur', (function(title) {
            title.classList.remove('hidden');
        }).bind(this, t));
    }

    var ctx = this.renderer.context;

    this.vertex_editor = new Editor(this.vertex_editor, ctx, glsl.source.VERTEX);
    this.fragment_editor = new Editor(this.fragment_editor, ctx, glsl.source.FRAGMENT);
    this.js_editor = new Editor(this.js_editor, ctx, 'javascript');

    var editors = {
        'vertex': this.vertex_editor,
        'fragment': this.fragment_editor,
        'js': this.js_editor
    };

    for (var n in editors) {
        editors[n].editor.on('changes', (function(n) {
            this._update_document(n, editors[n]);
        }).bind(this, n));

        editors[n].editor.on('cursorActivity', (function(n) {
            this._update_document_by({
                active_editor: {
                    name: n,
                    cursor: editors[n].cursor()
                }
            });
        }).bind(this, n));
    }

    this._parsed_timeout = 0;
    this.vertex_editor.on('notify::parsed', this._on_editor_parsed, this);
    this.fragment_editor.on('notify::parsed', this._on_editor_parsed, this);
}

App.prototype._on_editor_parsed = function() {
    if (this._parsed_timeout !== 0) {
        clearTimeout(this._parsed_timeout);
    }

    this._parsed_timeout = setTimeout((function() {
        this._parsed_timeout = 0;

        if (this.vertex_editor.parsed !== null && this.fragment_editor.parsed !== null) {
            var linker = new glsl.linker.Linker(this.vertex_editor.parsed, this.fragment_editor.parsed);
            var errors = linker.link();

            this.vertex_editor.external_errors(errors.vertex);
            this.fragment_editor.external_errors(errors.fragment);
        }
    }).bind(this), 50);
}

App.prototype.message = function(type, m) {
    var div = document.createElement('div');
    this._message = div;

    div.classList.add('message');
    div.classList.add(type);

    if (typeof m === 'string') {
        div.textContent = m;
    } else {
        div.appendChild(m);
    }

    var overlay = this._addOverlay();
    document.body.appendChild(div);

    var w = div.offsetWidth;
    var h = div.offsetHeight;

    div.style.left = ((document.body.offsetWidth - w) / 2) + 'px';
    div.style.top = ((document.body.offsetHeight - h) / 2) + 'px';

    var remover = (function() {
        window.removeEventListener('keydown', this._messageKeydown);
        window.removeEventListener('mousedown', this._messageMousedown);

        document.body.removeChild(overlay);
        document.body.removeChild(div);
    }).bind(this);

    this._messageKeydown = (function(e) {
        if (e.keyCode === 27) {
            remover();
        }
    }).bind(this);

    this._messageMousedown = (function(e) {
        if (e.pageX < div.offsetLeft || e.pageX > div.offsetLeft + div.offsetWidth ||
            e.pageY < div.offsetTop || e.pageY > div.offsetTop + div.offsetHeight) {
            remover();
        }
    }).bind(this);

    window.addEventListener('keydown', this._messageKeydown);
    window.addEventListener('mousedown', this._messageMousedown);

    return remover;
}

App.prototype._on_button_share_click = function() {
    var req = new XMLHttpRequest();
    var doc = this.document;

    req.onload = (function(ev) {
        var req = ev.target;

        if (req.status === 200) {
            var ret = JSON.parse(req.responseText);

            if (this.document === doc) {
                this._update_document_by({
                    share: ret.hash
                });

                var l = document.location;
                var url = l.protocol + '//' + l.host + '/d/' + ret.hash;

                window.history.replaceState({}, '', url);

                var e = document.createElement('div');

                var s = document.createElement('span');
                s.textContent = 'Shared document at ';
                e.appendChild(s);

                s = document.createElement('span');
                s.textContent = url;
                e.appendChild(s);

                this.message('ok', e);

                var selection = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(s);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } else {
            this.message('error', 'Failed to upload document: ' + req.responseText);
        }
    }).bind(this);

    req.onerror = (function(ev) {
        this.message('error', 'Failed to upload document');
    }).bind(this);

    req.open('post', '/d/new', true);
    req.send(JSON.stringify(this.document.remote()));
}

App.prototype._on_button_export_click = function() {
    var saveas = require('../vendor/FileSaver');

    var blob = new Blob([JSON.stringify(this.document.remote(), undefined, 2)], {type: 'application/json;charset=utf-8'});
    saveas(blob, this.document.title + '.json');
}

App.prototype._init_programs_bar = function() {
    this.programs_bar = new ui.ProgramsBar(document.getElementById('programs-sidebar'), this);
}

App.prototype._show_opengl_popup = function(cb) {
    var gl = this.renderer.context.gl;

    var exts = gl.getSupportedExtensions();
    exts.sort();

    for (var i = 0; i < exts.length; i++) {
        exts[i] = ui.Widget.createUi('div', {
            children: ui.Widget.createUi('a', {
                href: 'https://www.khronos.org/registry/webgl/extensions/' + exts[i],
                textContent: exts[i]
            })
        });
    }

    var content = ui.Widget.createUi('table', {
        classes: 'opengl',
        children: [
            ui.Widget.createUi('tr', {
                children: [
                    ui.Widget.createUi('td', { textContent: 'Supported Extensions:' }),
                    ui.Widget.createUi('td', {
                        children: ui.Widget.createUi('div', {
                            classes: 'extensions',
                            children: exts
                        })
                    })
                ]
            })
        ]
    });

    var popup = new ui.Popup(content, this.buttons.opengl.e);
    cb(popup);
}

App.prototype._init_buttons = function() {
    var buttons = ['new', 'copy', 'export', 'models', 'open', 'opengl', 'help', 'share', 'publish'];

    this.buttons = {};

    for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var elem = document.getElementById('button-' + b);

        if (elem) {
            var button = new ui.Button({ wrap: elem });

            var eh = '_on_button_' + b + '_click';

            if (eh in this) {
                button.on('click', this[eh], this);
            }

            this.buttons[b] = button;
        }
    }

    ui.Popup.on(this.buttons.open.e, this._show_open_popup.bind(this));
    ui.Popup.on(this.buttons.models.e, this._show_models_popup.bind(this));
    ui.Popup.on(this.buttons.opengl.e, this._show_opengl_popup.bind(this));
}

App.prototype._on_button_copy_click = function() {
    var title = 'Copy of ' + this.document.title;

    var doc = Document.deserialize(this._serialize_document(this.document));

    doc.id = null;
    doc.title = title;

    this._load_doc(doc);
}

App.prototype._rel_date = function(date) {
    var now = new Date();
    var t = (now - date) / 1000;

    var MINUTE = 60;
    var HOUR = MINUTE * 60;
    var DAY = HOUR * 24;
    var WEEK = DAY * 7;

    if (t < 29.5 * MINUTE) {
        var mins = Math.round(t / MINUTE);

        if (mins === 0) {
            return 'less than a minute ago';
        } else if (mins === 1) {
            return 'a minute ago';
        } else {
            return mins + ' minutes ago';
        }
    } else if (t < 45 * MINUTE) {
        return 'half an hour ago';
    } else if (t < 23.5 * HOUR) {
        var hours = Math.round(t / HOUR);

        if (hours === 1) {
            return 'an hour ago';
        } else {
            return hours + ' hours ago';
        }
    } else if (t < 7 * DAY) {
        var days = Math.round(t / DAY);

        if (days === 1) {
            return 'a day ago';
        } else {
            return days + ' days ago';
        }
    } else {
        return 'on ' + date.toDateString();
    }
}

App.prototype._show_models_popup = function(cb) {
    var popup;

    this._store.models((function(store, ret) {
        var W = ui.Widget.createUi;
        var content = W('div', { classes: 'models' });

        var li = W('li', {
            classes: 'import',
            innerHTML: 'Import&nbsp;from&nbsp;file',
            title: 'Import a model from a local file'
        });

        li.addEventListener('click', (function() {
            var inp = W('input', { type: 'file', multiple: 'multiple' });

            inp.onchange = (function() {
                var reader = new ui.FilesReader(inp.files);
                var msg;

                if (inp.files.length === 1) {
                    msg = 'Importing 1 model from file';
                } else {
                    msg = 'Importing ' + inp.files.length + ' models from files';
                }

                var but = new ui.Button({
                    value: 'Close'
                });

                var remover = this.message('files', W('div', {
                    classes: 'files',
                    children: [
                        W('div', {
                            classes: 'title',
                            textContent: msg
                        }),

                        reader.e,

                        W('div', {
                            classes: 'actions',
                            children: but.e
                        })
                    ]
                }));

                but.on('click', (function() {
                    remover();
                }).bind(this));

                reader.on('loaded', (function(r, f, data) {
                    if (data !== null) {
                        this._store.addModel({
                            filename: f.name,
                            modification_time: f.lastModifiedDate,
                            creation_time: new Date()
                        }, data, (function(store, model) {
                            reader.finished(f, model !== null);
                        }).bind(this));
                    }
                }).bind(this));

                reader.on('finished', (function() {
                    this._update_renderer();
                }).bind(this));

                popup.destroy();
            }).bind(this);

            inp.click();
        }).bind(this));

        content.appendChild(li);

        var popup;

        for (var i = 0; i < ret.length; i++) {
            var sc = {
                classes: 'screenshot'
            };

            if (ret[i].screenshot) {
                sc.src = ret[i].screenshot;
            }

            var li = W('li', {
                children: [
                    W('div', {
                        classes: 'screenshot-container',
                        children: W('img', sc)
                    }),

                    W('div', {
                        classes: 'filename',
                        textContent: ret[i].filename
                    }),

                    W('div', {
                        classes: 'modification-time',
                        textContent: 'Added ' + this._rel_date(ret[i].creation_time)
                    }),

                    W('div', {
                        classes: 'delete',
                        textContent: '×',
                        title: 'Delete model'
                    })
                ]
            });

            var del = li.querySelector('.delete');

            del.addEventListener('click', (function(model, li, del, e) {
                var spinner = new ui.Spinner();

                del.textContent = '';
                del.classList.add('spinning');

                del.appendChild(spinner.e);
                spinner.start();

                this._store.deleteModel(model, (function(store, deleted) {
                    spinner.cancel();
                    del.removeChild(spinner.e);
                    del.classList.remove('spinning');

                    if (deleted) {
                        content.removeChild(li);
                        this._update_renderer();
                    } else {
                        del.textContent = '×';
                    }
                }).bind(this));

                e.preventDefault();
                e.stopPropagation();
            }).bind(this, ret[i], li, del));

            content.appendChild(li);
        }

        popup = new ui.Popup(content, this.buttons.models.e);

        popup.on('destroy', (function() {
            if (this._lastFocus) {
                this._lastFocus.focus();
            }
        }).bind(this));

        cb(popup);
    }).bind(this));
}

App.prototype._show_open_popup = function(cb) {
    var popup;

    this._store.all((function(store, ret) {
        var W = ui.Widget.createUi;
        var content = W('ul', { classes: 'documents' });

        var li = W('li', {
            classes: 'import',
            innerHTML: 'Import&nbsp;from&nbsp;file',
            title: 'Import a previously exported document'
        });

        li.addEventListener('click', (function() {
            var inp = W('input', { type: 'file', multiple: 'multiple' });

            inp.onchange = (function() {
                var reader = new ui.FilesReader(inp.files);
                var msg;

                if (inp.files.length === 1) {
                    msg = 'Importing 1 document from file';
                } else {
                    msg = 'Importing ' + inp.files.length + ' documents from files';
                }

                var but = new ui.Button({
                    value: 'Close'
                });

                var remover = this.message('files', W('div', {
                    classes: 'files',
                    children: [
                        W('div', {
                            classes: 'title',
                            textContent: msg
                        }),

                        reader.e,

                        W('div', {
                            classes: 'actions',
                            children: but.e
                        })
                    ]
                }));

                but.on('click', (function() {
                    remover();
                }).bind(this));

                var docs = new Array(inp.files.length);

                reader.on('loaded', (function(i, r, f, data) {
                    var doc = Document.fromRemote(null, JSON.parse(data));
                    this._save_doc(doc);

                    docs[i] = doc;

                    r.finished(f, true);
                }).bind(this, i));

                reader.on('finished', (function() {
                    for (var i = docs.length - 1; i >= 0; i--) {
                        if (docs[i]) {
                            this._load_doc(docs[i]);
                            break;
                        }
                    }
                }).bind(this));

                popup.destroy();
            }).bind(this);

            inp.click();
        }).bind(this));

        content.appendChild(li);

        for (var i = 0; i < ret.length; i++) {
            var li = W('li', {
                children: [
                    W('div', {
                        classes: 'screenshot-container',
                        children: W('img', {
                            classes: 'screenshot',
                            src: ret[i].screenshot
                        })
                    }),

                    W('div', {
                        classes: 'title',
                        textContent: ret[i].title
                    }),

                    W('div', {
                        classes: 'modification-time',
                        textContent: 'Last modified ' + this._rel_date(ret[i].modification_time)
                    }),

                    W('div', {
                        classes: 'delete',
                        textContent: '×',
                        title: 'Delete document'
                    })
                ]
            });

            if (this.document !== null && ret[i].id === this.document.id) {
                var title = li.querySelector('.title');
                title.classList.add('active');
            }

            li.addEventListener('click', (function(doc) {
                this._load_doc(Document.deserialize(doc));
                popup.destroy();
            }).bind(this, ret[i]));

            var del = li.querySelector('.delete');

            del.addEventListener('click', (function(doc, li, del, e) {
                if (content.querySelectorAll('li').length > 1) {
                    var spinner = new ui.Spinner();

                    del.textContent = '';
                    del.classList.add('spinning');

                    del.appendChild(spinner.e);
                    spinner.start();

                    this._store.delete(doc, (function(store, doc) {
                        spinner.cancel();
                        del.removeChild(spinner.e);
                        del.classList.remove('spinning');

                        if (doc) {
                            content.removeChild(li);

                            if (this.document.id === doc.id) {
                                this.document.id = null;
                            }
                        } else {
                            del.textContent = '×';
                        }
                    }).bind(this));
                }

                e.preventDefault();
                e.stopPropagation();
            }).bind(this, ret[i], li, del));

            content.appendChild(li);
        }

        popup = new ui.Popup(content, this.buttons.open.e);

        popup.on('destroy', (function() {
            if (this._lastFocus) {
                this._lastFocus.focus();
            }
        }).bind(this));

        cb(popup);
    }).bind(this));
}

App.prototype._on_button_new_click = function() {
    this._save_current_doc((function(saved) {
        if (saved) {
            this.new_document();
        }
    }).bind(this));
}

App.prototype._addOverlay = function() {
    var overlay = document.createElement('div');
    overlay.classList.add('overlay');

    document.body.appendChild(overlay);
    overlay.offsetWidth;
    overlay.classList.add('animate');

    return overlay;
}

App.prototype._show_info_popup = function() {
    var content = document.createElement('div');
    content.classList.add('info-popup');

    var title = document.createElement('input');
    title.setAttribute('type', 'text');

    title.classList.add('title');
    title.value = this.document.title;
    content.appendChild(title);

    var f = (function() {
        this._update_document_by({
            title: title.value
        });

        this._save_current_doc_with_delay();
    }).bind(this);

    title.addEventListener('input', f);
    title.addEventListener('change', f);

    var description = document.createElement('div');
    description.classList.add('description');

    var desc = (function() {
        if (this.document.description) {
            description.classList.remove('empty');
            return this.document.description;
        } else {
            description.classList.add('empty');
            return 'Description not set. Double-click to start editing.';
        }
    }).bind(this);

    description.innerHTML = marked(desc());
    content.appendChild(description);

    var close = new ui.Button();

    close.e.classList.add('close');
    close.e.textContent = 'Close Editor';

    content.appendChild(close.e);

    var editor = document.createElement('textarea');

    var saveEditor = (function() {
        this._update_document_by({
            description: editor.value
        });

        this._save_current_doc_with_delay();
    }).bind(this);

    editor.addEventListener('keydown', (function(e) {
        if (e.keyCode === 27) { // escape
            saveEditor();
            description.innerHTML = marked(desc());

            content.classList.remove('editing');
            close.e.classList.remove('animate');

            e.stopPropagation();
            e.preventDefault();
        }
    }).bind(this));

    editor.addEventListener('blur', (function(e) {
        if (content.classList.contains('editing')) {
            saveEditor();
        }
    }).bind(this));

    content.appendChild(editor);

    close.on('click', function() {
        saveEditor();
        description.innerHTML = marked(desc());

        content.classList.remove('editing');
        close.e.classList.remove('animate');
    }, this);

    description.addEventListener('dblclick', (function() {
        editor.value = this.document.description || '';

        content.classList.add('editing');
        close.e.offsetWidth;
        close.e.classList.add('animate');

        editor.focus();

        editor.selectionStart = 0;
        editor.selectionEnd = 0;
    }).bind(this));

    var overlay = this._addOverlay();
    this._info_popup = new ui.Popup(content, this.title);

    this._info_popup.on('destroy', function() {
        if (content.classList.contains('editing')) {
            saveEditor();
        }

        this._info_popup = null;
        document.body.removeChild(overlay);

        if (this._lastFocus) {
            this._lastFocus.focus();
        }
    }, this);
}

App.prototype._init_title = function() {
    this.title = document.getElementById('document-title');
    ui.Popup.on(this.title, this._show_info_popup.bind(this));
}

App.prototype._init = function() {
    this._store = new Store((function(store) {
        var m = document.location.pathname.match(/d\/([A-Za-z0-9]+)/);

        var f = (function(doc) {
            var saved = localStorage.getItem('savedDocumentBeforeUnload');

            if (saved !== null && doc !== null) {
                saved = JSON.parse(saved);

                if (saved && typeof saved.id !== 'undefined' && saved.id === doc.id)
                {
                    saved.modification_time = new Date(saved.modification_time);
                    saved.creation_time = new Date(saved.creation_time);

                    this._load_doc(Document.deserialize(saved));
                    this._save_current_doc_with_delay();

                    localStorage.setItem('savedDocumentBeforeUnload', null);

                    return;
                }
            }

            this.load_document(doc);
        }).bind(this);

        if (m) {
            store.byShare(m[1], (function(_, doc) {
                if (doc !== null) {
                    f(doc);
                } else {
                    // We don't have it, request it remotely
                    var req = new XMLHttpRequest();

                    req.onload = (function(e) {
                        var req = e.target;

                        if (req.status === 200) {
                            var jdoc;

                            try {
                                jdoc = JSON.parse(req.responseText);
                            } catch (e) {
                                this.message('error', 'Failed parse document: ' + e.message);
                                return;
                            }

                            f(Document.fromRemote(m[1], jdoc));
                        } else {
                            this.message('error', 'Failed to load document: ' + req.textContent);
                        }

                    }).bind(this);

                    req.onerror = (function(e) {
                        this.message('error', 'Failed to load document ' + m[1]);
                    }).bind(this);

                    req.open('get', '/d/' + m[1] + '.json');
                    req.send();
                }
            }).bind(this));
        } else {
            store.last((function(_, doc) {
                f(doc);
            }).bind(this));
        }
    }).bind(this));

    this.content = document.getElementById('content');

    this._init_programs_bar();
    this._init_canvas();
    this._init_editors();
    this._init_buttons();
    this._init_panels();
    this._init_title();

    this._update_canvas_size();

    window.onbeforeunload = (function(e) {
        this._update_editors();
        localStorage.setItem('savedDocumentBeforeUnload', JSON.stringify(this._serialize_document(this.document)));
    }).bind(this);
};

var app = new App();
module.exports = app;

// vi:ts=4:et
