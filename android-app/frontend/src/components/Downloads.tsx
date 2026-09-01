import { useDownloads, cancelDownload, deleteDownload } from '../hooks/useDownloads';
import { apiGet } from '../api';
import { pickTracks } from './Modal';

interface Live {
  done: number;
  total: number;
  bytes: number;
  status: string;
}

export default function Downloads() {
  const { records, live, refresh } = useDownloads();

  const handleOpenWith = async (raw: string) => {
    try {
      const tracks = await apiGet<{ audio: any[]; video: any[] }>(
        '/api/v1/tracks?url=' + encodeURIComponent(raw)
      );
      const pick = await pickTracks(tracks, { audioOnly: true });
      if (!pick) return;
      const url =
        '/api/v1/ext_url?url=' +
        encodeURIComponent(raw) +
        '&audio=' +
        encodeURIComponent(pick.lang || '');
      const j = await (await fetch(url)).json();
      if ((window as any).AnimeBridge?.openExternal) {
        (window as any).AnimeBridge.openExternal(j.url);
      } else {
        location.href = j.url;
      }
    } catch (e) {
      alert('Could not open external player: ' + (e as Error).message);
    }
  };

  const items = records.map((r) => {
    const l: Live = live[r.id] || {
      done: r.done,
      total: r.total,
      bytes: r.bytes,
      status: r.status,
    };
    const pct = l.total ? Math.min(100, Math.round((100 * l.done) / l.total)) : 0;
    const mb = (l.bytes || 0) / 1048576;
    const label = {
      queued: 'Queued',
      downloading: 'Downloading',
      done: 'Completed',
      error: 'Error',
      canceled: 'Canceled',
    }[l.status] || l.status;
    const audios = (r.audio || []).map((a: any) => a.name).join(', ') || 'embedded';

    return (
      <div className="dl-card" key={r.id}>
        <img
          className="dl-poster"
          src={r.poster || ''}
          onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
        />
        <div className="dl-info">
          <div className="dl-title">{r.title}</div>
          <div className="dl-meta">
            {r.qualityLabel || ''} · {audios}
          </div>
          <div className="dl-bar-wrap">
            <div className="dl-bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="dl-sub">
            {label} {pct}% · {mb.toFixed(1)} MB
            {l.status === 'downloading' ? ` · ${l.done}/${l.total}` : ''}
          </div>
        </div>
        <div className="dl-actions">
          {l.status === 'done' && (
            <a className="navlink" href={`#/offline/${encodeURIComponent(r.id)}`}>
              Play
            </a>
          )}
          {l.status !== 'done' && (
            <button
              className="navlink ext"
              onClick={() => handleOpenWith(r.masterRaw)}
            >
              Open with
            </button>
          )}
          <button
            className="navlink del"
            onClick={async () => {
              if (l.status === 'downloading' || l.status === 'queued') {
                await cancelDownload(r.id);
              } else {
                await deleteDownload(r.id);
              }
              refresh();
            }}
          >
            {l.status === 'downloading' || l.status === 'queued' ? 'Cancel' : 'Delete'}
          </button>
        </div>
      </div>
    );
  });

  return (
    <section className="downloads">
      <h1>Downloads</h1>
      {items.length === 0 && (
        <p className="muted">
          No downloads yet. Open an episode and tap <b>Download</b>.
        </p>
      )}
      <p className="muted small">
        Up to 3 downloads run at once; the rest are queued. The app must stay
        open while downloading. Tap an item to play it offline once finished.
      </p>
    </section>
  );
}
