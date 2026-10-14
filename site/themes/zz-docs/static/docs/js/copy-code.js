(function () {
  var ICON = '⧉'; // "⧉", the exact glyph the web app's own copy buttons use

  document.querySelectorAll('.prose pre').forEach(function (pre) {
    // A sibling of <pre>, inside a wrapper div -- not a child of <pre>
    // itself, same reason the web app's own .pre-wrap pattern does
    // this: a child button's own icon text would get swept up into
    // pre.innerText (what actually gets copied) along with the real
    // code.
    var wrap = document.createElement('div');
    wrap.className = 'copy-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.textContent = ICON;

    btn.addEventListener('click', function () {
      // innerText, not textContent -- a chroma-highlighted block's own
      // line-number spans are display:none (see site.css), and
      // innerText is the one DOM text accessor that already skips
      // whatever isn't actually rendered, so the line numbers never
      // end up pasted along with the real command.
      var text = pre.innerText;
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = ICON;
          btn.classList.remove('copied');
        }, 1200);
      });
    });

    wrap.appendChild(btn);
  });
})();
