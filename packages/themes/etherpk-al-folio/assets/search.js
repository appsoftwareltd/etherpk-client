/*
 * Search for a Published Site: reads search.json (built over the publication's own documents
 * and nothing else) and scores documents by title and text matches. No dependencies, no
 * network beyond the one index file, and nothing runs until the search box is used. The same
 * script runs the sidebar toggle on small screens, so a page carries one script.
 */
(function () {
    'use strict';

    // -- Navigation toggle (small screens) -------------------------------------------------
    var toggle = document.querySelector('.nav-toggle');
    var backdrop = document.querySelector('.nav-backdrop');
    var nav = document.getElementById('site-nav');
    function setNavOpen(open) {
        var was = document.body.classList.contains('nav-open');
        document.body.classList.toggle('nav-open', open);
        if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (backdrop) backdrop.hidden = !open;
        // Focus follows the drawer: into its first link on open, back to the button on close,
        // so a keyboard or screen-reader user is never left on something now hidden.
        if (open && !was) {
            var first = nav.querySelector('a');
            if (first) first.focus();
        } else if (!open && was && toggle) {
            toggle.focus();
        }
    }
    if (toggle && nav) {
        toggle.addEventListener('click', function () { setNavOpen(!document.body.classList.contains('nav-open')); });
        if (backdrop) backdrop.addEventListener('click', function () { setNavOpen(false); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNavOpen(false);
        });
    }

    // -- Search --------------------------------------------------------------------------
    var form = document.querySelector('.site-search');
    if (!form) return;
    var input = form.querySelector('input[type="search"]');
    var results = form.querySelector('.site-search-results');
    var indexUrl = form.getAttribute('data-search-index') || 'search.json';
    var scriptUrl = form.getAttribute('data-search-script') || 'search-index.js';
    var index = null;
    var loading = null;
    /* True once neither route produced the index: the results then say so rather than "nothing matches". */
    var unavailable = false;

    /* The index as a script assigning window.etherpkSearchIndex: what a site opened from disk can
       load, since file:// refuses fetch but allows <script src>. */
    function loadScript() {
        return new Promise(function (resolve, reject) {
            if (window.etherpkSearchIndex) { resolve(window.etherpkSearchIndex); return; }
            var s = document.createElement('script');
            s.src = scriptUrl;
            s.onload = function () {
                if (window.etherpkSearchIndex) resolve(window.etherpkSearchIndex);
                else reject(new Error('no index'));
            };
            s.onerror = function () { reject(new Error('no script')); };
            document.head.appendChild(s);
        });
    }

    function load() {
        if (index) return Promise.resolve(index);
        if (!loading) {
            loading = fetch(indexUrl).then(function (r) {
                if (!r.ok) throw new Error(String(r.status));
                return r.json();
            }).catch(loadScript).then(function (data) {
                index = (data && data.documents) || [];
                return index;
            }).catch(function () { unavailable = true; index = []; return index; });
        }
        return loading;
    }

    function tokens(q) {
        return q.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
    }

    function score(doc, terms) {
        var title = (doc.title || '').toLowerCase();
        var text = (doc.text || '').toLowerCase();
        var s = 0;
        for (var i = 0; i < terms.length; i++) {
            var t = terms[i];
            if (title === t) s += 20;
            else if (title.indexOf(t) === 0) s += 10;
            else if (title.indexOf(t) !== -1) s += 6;
            var at = text.indexOf(t);
            if (at !== -1) s += 2;
            else if (title.indexOf(t) === -1) return 0; // every term must match somewhere
        }
        return s;
    }

    function snippet(doc, terms) {
        var text = doc.text || '';
        var lower = text.toLowerCase();
        var at = -1;
        for (var i = 0; i < terms.length && at === -1; i++) at = lower.indexOf(terms[i]);
        if (at === -1) return doc.excerpt || '';
        var start = Math.max(0, at - 60);
        var end = Math.min(text.length, at + 100);
        return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function render(list, q) {
        if (!q) { results.hidden = true; results.innerHTML = ''; return; }
        if (unavailable) {
            results.innerHTML = '<p class="site-search-empty">The search index could not be loaded.</p>';
            results.hidden = false;
            return;
        }
        if (list.length === 0) {
            results.innerHTML = '<p class="site-search-empty">Nothing matches "' + escapeHtml(q) + '".</p>';
            results.hidden = false;
            return;
        }
        results.innerHTML = list.map(function (hit) {
            return '<a class="site-search-hit" role="option" href="' + escapeHtml(hit.doc.url) + '">' +
                '<span class="site-search-title">' + escapeHtml(hit.doc.title) + '</span>' +
                '<span class="site-search-snippet">' + escapeHtml(hit.snippet) + '</span></a>';
        }).join('');
        results.hidden = false;
    }

    var timer = null;
    function run() {
        var q = input.value.trim();
        var terms = tokens(q);
        if (terms.length === 0) { render([], ''); return; }
        load().then(function (docs) {
            var hits = [];
            for (var i = 0; i < docs.length; i++) {
                var s = score(docs[i], terms);
                if (s > 0) hits.push({ doc: docs[i], score: s, snippet: snippet(docs[i], terms) });
            }
            hits.sort(function (a, b) { return b.score - a.score || a.doc.title.localeCompare(b.doc.title); });
            render(hits.slice(0, 12), q);
        });
    }

    input.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(run, 120);
    });
    input.addEventListener('focus', function () { load(); });
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var first = results.querySelector('a');
        if (first) window.location.href = first.getAttribute('href');
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) {
            e.preventDefault();
            input.focus();
        }
        if (e.key === 'Escape' && !results.hidden) { render([], ''); }
    });
    document.addEventListener('click', function (e) {
        if (!form.contains(e.target)) render([], '');
    });
})();
