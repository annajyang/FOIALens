'use client';

import { useRef, useState } from 'react';

interface UploadZoneProps {
  files: File[];
  onChange: (files: File[]) => void;
}

export default function UploadZone({ files, onChange }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const pdfs = Array.from(incoming).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    const next = [...files];
    for (const f of pdfs) {
      if (!next.some(e => e.name === f.name && e.size === f.size)) next.push(f);
    }
    onChange(next);
  }

  function remove(idx: number) {
    onChange(files.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div
        className={`dropzone ${dragging ? 'drag-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      >
        Drop PDFs here or <b>browse</b>
        <br />
        <span style={{ fontSize: 10, color: 'var(--fg-mute)', marginTop: 6, display: 'inline-block', letterSpacing: '0.04em' }}>
          MAX 50MB · up to 20 files
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          multiple
          style={{ display: 'none' }}
          onChange={e => addFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <div className="modal-file-list">
          {files.map((f, i) => (
            <div key={i} className="modal-file">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 8 }}>
                <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}>{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                <button onClick={() => remove(i)} style={{ color: 'var(--fg-mute)', fontSize: 14, lineHeight: 1 }}>×</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
