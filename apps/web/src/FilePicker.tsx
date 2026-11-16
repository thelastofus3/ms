import type { InputHTMLAttributes } from "react";

/** File input with English labels; the native control shows the browser's locale instead. Pass `files` to show the selection. */
export function FilePicker({ files, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { files?: File[] }) {
  return <span className="file-picker"><input type="file" {...props} /><span className="file-picker-button" aria-hidden="true">{props.multiple ? "Choose files" : "Choose file"}</span>
    {files && <span className="file-picker-name" aria-hidden="true">{!files.length ? props.multiple ? "No files chosen" : "No file chosen" : files.length === 1 ? files[0].name : `${files.length} files`}</span>}</span>;
}
