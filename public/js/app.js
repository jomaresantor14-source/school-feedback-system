(function () {
    'use strict';

    // Anonymous toggle: dim and disable the identity fields
    var anon = document.getElementById('is_anonymous');
    var identity = document.getElementById('identity');

    function syncAnonymous() {
        if (!anon || !identity) return;
        identity.classList.toggle('is-disabled', anon.checked);
        identity.querySelectorAll('input').forEach(function (input) {
            input.disabled = anon.checked;
        });
    }

    if (anon) {
        anon.addEventListener('change', syncAnonymous);
        syncAnonymous();
    }

    // Live character counters
    document.querySelectorAll('[data-count]').forEach(function (field) {
        var output = document.getElementById(field.getAttribute('data-count'));
        if (!output) return;

        function update() { output.textContent = field.value.length; }
        field.addEventListener('input', update);
        update();
    });

    // Copy the reference code
    document.querySelectorAll('[data-copy]').forEach(function (button) {
        button.addEventListener('click', function () {
            var text = button.getAttribute('data-copy');
            var label = button.querySelector('[data-copy-label]');

            function done(message) {
                if (!label) return;
                var original = label.textContent;
                label.textContent = message;
                setTimeout(function () { label.textContent = original; }, 2000);
            }

            function fallback() {
                var area = document.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                try {
                    document.execCommand('copy');
                    done('Copied');
                } catch (err) {
                    done('Press Ctrl+C');
                }
                document.body.removeChild(area);
            }

            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(function () { done('Copied'); }, fallback);
            } else {
                fallback();
            }
        });
    });

    // Print button
    document.querySelectorAll('[data-print]').forEach(function (button) {
        button.addEventListener('click', function () { window.print(); });
    });

    // Filters apply as soon as a dropdown changes
    document.querySelectorAll('[data-autosubmit]').forEach(function (select) {
        select.addEventListener('change', function () {
            if (select.form) select.form.submit();
        });
    });

    // Stop double submissions
    document.querySelectorAll('form[method="POST"], form[method="post"]').forEach(function (form) {
        form.addEventListener('submit', function () {
            if (form.dataset.submitted === '1') return;
            form.dataset.submitted = '1';

            setTimeout(function () {
                form.querySelectorAll('button[type="submit"]').forEach(function (button) {
                    button.disabled = true;
                });
            }, 0);
        });
    });

    // Restore buttons if the browser returns to a cached form
    window.addEventListener('pageshow', function (event) {
        if (!event.persisted) return;
        document.querySelectorAll('form[data-submitted]').forEach(function (form) {
            delete form.dataset.submitted;
            form.querySelectorAll('button[type="submit"]').forEach(function (button) {
                button.disabled = false;
            });
        });
    });
})();
