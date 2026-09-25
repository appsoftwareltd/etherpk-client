/*
 * The light / dark toggle: a `.theme-toggle` button flips the page between the two and the
 * choice is remembered in this browser; with no choice made the page follows the system. The
 * stylesheet keys on `data-theme` on <html>, and shell-top applies the remembered choice before
 * the first paint so a dark reader never sees a light flash.
 */
(function () {
    'use strict';
    var KEY = 'etherpk-theme';
    var root = document.documentElement;
    function isDark() {
        var chosen = root.getAttribute('data-theme');
        if (chosen === 'dark' || chosen === 'light') return chosen === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    function apply(theme) {
        if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
        else root.removeAttribute('data-theme');
        var buttons = document.querySelectorAll('.theme-toggle');
        for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', isDark() ? 'true' : 'false');
    }
    try { apply(localStorage.getItem(KEY)); } catch (_e) { apply(null); }
    var toggles = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < toggles.length; i++) {
        toggles[i].addEventListener('click', function () {
            var next = isDark() ? 'light' : 'dark';
            apply(next);
            try { localStorage.setItem(KEY, next); } catch (_e) { /* private mode: the choice lasts the page */ }
        });
    }
})();
