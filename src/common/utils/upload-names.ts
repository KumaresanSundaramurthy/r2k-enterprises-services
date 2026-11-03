// File names CI3 gives uploaded files, so objects written by either app look the same in storage.

// PHP uniqid(): 13 hex characters from the current time in microseconds
export function phpUniqid(now: number = Date.now()): string {
  return Math.floor(now / 1000).toString(16) + ((now % 1000) * 1000).toString(16).padStart(5, "0");
}

// Globalservice::fileUploadService — spaces → "_", extension removed, first 50 characters, then _<uniqid>.<ext>
export function uniqueUploadName(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  const ext = dot >= 0 ? originalName.slice(dot + 1) : "";
  const base = originalName.replace(/ /g, "_").split(`.${ext}`).join("").slice(0, 50);
  return `${base}_${phpUniqid()}.${ext}`;
}

// time() . '_' [. $i . '_'] . name with anything but letters, digits, ".", "_" and "-" replaced by "_"
export function timestampedUploadName(originalName: string, index?: number): string {
  const seconds = Math.floor(Date.now() / 1000);
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return index === undefined ? `${seconds}_${safe}` : `${seconds}_${index}_${safe}`;
}
