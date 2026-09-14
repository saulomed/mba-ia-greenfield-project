import { buildAttachmentContentDisposition } from './content-disposition.util';

describe('buildAttachmentContentDisposition', () => {
  it('builds an ASCII fallback and a UTF-8 filename* for accented names', () => {
    const header = buildAttachmentContentDisposition('Minhas Férias.mp4');

    expect(header).toBe(
      'attachment; filename="Minhas Ferias.mp4"; filename*=UTF-8\'\'Minhas%20F%C3%A9rias.mp4',
    );
  });

  it('keeps a plain ASCII filename unchanged in both parts', () => {
    const header = buildAttachmentContentDisposition('vacation.mp4');

    expect(header).toBe(
      'attachment; filename="vacation.mp4"; filename*=UTF-8\'\'vacation.mp4',
    );
  });

  it('replaces quotes and backslashes in the ASCII fallback', () => {
    const header = buildAttachmentContentDisposition('weird"name\\.mp4');

    expect(header).toContain('filename="weird_name_.mp4"');
  });
});
