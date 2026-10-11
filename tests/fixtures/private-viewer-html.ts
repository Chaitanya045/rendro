const link = '<link rel="stylesheet" href="assets/site.css">';
export const viewerHtmlForms = [
  ["explicit head", `<!doctype html><html><head>${link}</head><body>Docs</body></html>`],
  ["implicit head", `<!doctype html><html>${link}<body>Docs</body></html>`],
  ["no head or body", `${link}<p>Docs</p>`],
  ["doctype-only start", `<!doctype html>${link}<p>Docs</p>`],
  ["comments before html", `<!-- <head><base href="wrong/"></head> --><!doctype html><!-- résumé 📖 --><html>${link}<body>Docs</body></html>`],
  ["uppercase tags", `<!DOCTYPE HTML><HTML><HEAD>${link.toUpperCase().replace('ASSETS/SITE.CSS', 'assets/site.css')}</HEAD><BODY>Docs</BODY></HTML>`],
] as const;
