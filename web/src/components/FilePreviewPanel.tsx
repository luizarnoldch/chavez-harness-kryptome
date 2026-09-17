export type FilePreviewData = {
  path: string;
  kind?: string;
  status?: string;
  byteSize?: number;
  mime?: string;
  truncated?: boolean;
  text?: string;
  mediaType?: string;
  imageBase64?: string;
  listing?: Array<{ name: string; isDir: boolean }>;
  notice?: string;
  error?: string;
};

export function FilePreviewPanel({
  data,
  loading,
}: {
  data: FilePreviewData | null;
  loading?: boolean;
}) {
  if (loading) return <p className="muted">Cargando preview…</p>;
  if (!data) {
    return <p className="muted">Elige un archivo para previsualizar.</p>;
  }
  if (data.status && data.status !== "ok") {
    return (
      <p className="error">
        {data.error || data.notice || data.status}
      </p>
    );
  }
  if (data.kind === "image" && data.imageBase64) {
    const src = `data:${data.mediaType || data.mime || "image/png"};base64,${data.imageBase64}`;
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path} · imagen · {data.byteSize} bytes
        </p>
        <img className="file-preview-img" src={src} alt={data.path} />
      </div>
    );
  }
  if (data.kind === "text" && typeof data.text === "string") {
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path}
          {data.truncated ? " · truncado" : ""}
        </p>
        <pre className="file-preview-text">{data.text}</pre>
      </div>
    );
  }
  if (data.kind === "directory") {
    return (
      <div className="file-preview">
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {data.path}/ · dir
        </p>
        <ul className="file-tree-list">
          {(data.listing || []).map((e) => (
            <li key={e.name}>{e.isDir ? `${e.name}/` : e.name}</li>
          ))}
        </ul>
        {data.notice && <p className="muted">{data.notice}</p>}
      </div>
    );
  }
  return (
    <div className="file-preview">
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        {data.path} · binario
      </p>
      <p>{data.notice || "Binario. No se muestra como texto."}</p>
    </div>
  );
}
