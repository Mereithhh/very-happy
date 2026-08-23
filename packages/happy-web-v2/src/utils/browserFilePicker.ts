/** Browser-native file picker shared by the Web V2 upload helpers. */
export function pickBrowserFile(accept?: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.hidden = true;
        if (accept) input.accept = accept;
        document.body.appendChild(input);

        let settled = false;
        const finish = (file: File | null) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', onWindowFocus);
            input.remove();
            resolve(file);
        };
        const onWindowFocus = () => {
            // Browsers restore focus after the native dialog closes. Defer one
            // tick so a preceding `change` event can publish the chosen file.
            window.setTimeout(() => finish(input.files?.[0] ?? null), 0);
        };

        input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
        window.addEventListener('focus', onWindowFocus, { once: true });
        input.click();
    });
}
