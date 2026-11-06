export type LegacyUpload = { rows: string[][] };
export const legacyUploadCount = (upload: LegacyUpload): number => upload.rows.length;
