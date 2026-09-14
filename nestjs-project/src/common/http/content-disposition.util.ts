function toAsciiFallback(filename: string): string {
  const withoutDiacritics = filename
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  return withoutDiacritics.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function toRfc5987Encoded(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildAttachmentContentDisposition(filename: string): string {
  const asciiFallback = toAsciiFallback(filename);
  const encoded = toRfc5987Encoded(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
