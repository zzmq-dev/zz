(function () {
  var headings = document.querySelectorAll(
    '.prose h2[id], .prose h3[id], .prose h4[id], .prose h5[id], .prose h6[id]'
  );

  headings.forEach(function (heading) {
    var link = document.createElement('a');
    link.className = 'heading-anchor';
    link.href = '#' + heading.id;
    link.setAttribute('aria-label', 'Copy link to this section');
    link.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
      '<path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.2l2-2a2.5 2.5 0 0 0-3.6-3.6l-1.1 1.1"/>' +
      '<path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.2l-2 2a2.5 2.5 0 0 0 3.6 3.6l1.1-1.1"/>' +
      '</svg>';

    link.addEventListener('click', function (event) {
      event.preventDefault();
      var url = window.location.origin + window.location.pathname + '#' + heading.id;
      history.replaceState(null, '', '#' + heading.id);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(function () {});
      }
      link.classList.add('copied');
      setTimeout(function () {
        link.classList.remove('copied');
      }, 1200);
    });

    heading.appendChild(link);
  });
})();
