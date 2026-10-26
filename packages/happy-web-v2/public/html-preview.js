// B-825: receives the HTML to preview from the app that frames this page
// (src/screens/files/HtmlPreviewFrame.tsx) and renders it in place. Only the
// direct parent is listened to; opened on its own, this page does nothing.
(function () {
  if (window.parent === window) return;
  window.addEventListener('message', function onMessage(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'vh-html-preview' || typeof data.html !== 'string') return;
    window.removeEventListener('message', onMessage);
    document.open();
    document.write(data.html);
    document.close();
  });
  window.parent.postMessage({ type: 'vh-html-preview-ready' }, '*');
})();
