import { useState, useEffect } from 'react';
import Player from './components/Player';
import Downloads from './components/Downloads';
import { apiGet } from './api';
import { startDownload, useDownloads } from './hooks/useDownloads';

function esc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function Card(it: any) {
  const img = it.poster ? (
    <img
      src={it.poster}
      loading="lazy"
      onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
    />
  ) : (
    <div className="ph">no image</div>
  );
  return (
    <a className="card" href={`#/series/${encodeURIComponent(it.slug)}`}>
      <div className="thumb">{img}</div>
      <div className="cap">{esc(it.title)}</div>
    </a>
  );
}

function HomePage() {
  const [feed, setFeed] = useState<any>(null);
  useEffect(() => {
    apiGet('/api/v1/feed?type=newest&limit=24').then(setFeed);
  }, []);
  if (!feed) return <p className="muted">Loading...</p>;
  return (
    <section className="row">
      <h2>New Episodes</h2>
      <div className="grid">{feed.items.map(Card)}</div>
    </section>
  );
}

function FeedPage({ kind }: { kind: string }) {
  const [feed, setFeed] = useState<any>(null);
  useEffect(() => {
    apiGet(`/api/v1/feed?type=${encodeURIComponent(kind)}&limit=48`).then(setFeed);
  }, [kind]);
  if (!feed) return <p className="muted">Loading...</p>;
  return (
    <section className="row">
      <h2>{esc(kind.replace(/^./, (c: string) => c.toUpperCase()))}</h2>
      <div className="grid">{feed.items.map(Card)}</div>
    </section>
  );
}

function CategoriesPage() {
  const [cats, setCats] = useState<any>(null);
  useEffect(() => {
    apiGet('/api/v1/categories?per_page=60').then(setCats);
  }, []);
  if (!cats) return <p className="muted">Loading...</p>;
  const chips = (cats.genres || []).map((g: any) => (
    <a
      className="chip"
      key={g.slug || g.name}
      href={`#/feed/${encodeURIComponent(g.slug || g.name)}`}
    >
      {esc(g.name)}
    </a>
  ));
  return (
    <section className="row">
      <h2>Categories</h2>
      <div className="chips">{chips}</div>
    </section>
  );
}

function SeriesPage({ slug }: { slug: string }) {
  const [series, setSeries] = useState<any>(null);
  useEffect(() => {
    apiGet(`/api/v1/series?slug=${encodeURIComponent(slug)}`).then(setSeries);
  }, [slug]);
  if (!series) return <p className="muted">Loading...</p>;
  const seasons = series.seasons || [];
  return (
    <section className="detail">
      <h1>{esc(series.title)}</h1>
      <div className="season-tabs">
        {seasons.map((x: any) => (
          <a
            className="tab"
            key={x.season}
            href={`#/seasons/${encodeURIComponent(slug)}/${x.season}`}
          >
            {esc(x.name || ('Season ' + x.season))}
          </a>
        ))}
      </div>
      <p className="muted">
        {seasons.length} season(s). Tap a season to list episodes.
      </p>
    </section>
  );
}

function SeasonsPage({ slug, season }: { slug: string; season: string }) {
  const [data, setData] = useState<{ s: any; eps: any } | null>(null);
  useEffect(() => {
    Promise.all([
      apiGet(`/api/v1/seasons?slug=${encodeURIComponent(slug)}&season=${season}`),
      apiGet(`/api/v1/episodes?slug=${encodeURIComponent(slug)}&season=${season}`),
    ]).then(([s, eps]) => setData({ s, eps }));
  }, [slug, season]);
  if (!data) return <p className="muted">Loading...</p>;
  return (
    <section className="detail">
      <h1>
        {esc(data.s.title)} — Season {esc(season)}
      </h1>
      <div className="ep-grid">
        {data.eps.episodes.map((e: any) => (
          <a className="ep" key={e.slug} href={`#/episode/${encodeURIComponent(e.slug)}`}>
            <span className="ep-no">EP {esc(e.episode)}</span>
            <span className="ep-title">{esc(e.title || '')}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function EpisodePage({ slug }: { slug: string }) {
  const [stream, setStream] = useState<any>(null);
  useEffect(() => {
    apiGet(`/api/v1/stream?slug=${encodeURIComponent(slug)}`).then(setStream);
  }, [slug]);
  if (!stream) return <p className="muted">Loading...</p>;
  return (
    <section className="watch">
      <h1>
        {esc(stream.title)} — Episode {esc(slug)}
      </h1>
      <Player
        poster={stream.poster}
        videoSource={stream.video_source}
        title={`${stream.title} — Ep ${slug}`}
        id={slug}
        raw
        onDownload={(rec) => startDownload(rec)}
      />
    </section>
  );
}

function WatchPage({ url }: { url: string }) {
  const [stream, setStream] = useState<any>(null);
  useEffect(() => {
    apiGet(`/api/v1/stream?url=${encodeURIComponent(url)}`).then(setStream);
  }, [url]);
  if (!stream) return <p className="muted">Loading...</p>;
  return (
    <section className="watch">
      <h1>{esc(stream.title)}</h1>
      <Player
        poster={stream.poster}
        videoSource={stream.video_source}
        title={'Movie: ' + stream.title}
        id={url}
        raw
        onDownload={(rec) => startDownload(rec)}
      />
    </section>
  );
}

function SearchPage({ q }: { q: string }) {
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => {
    apiGet(`/api/v1/search?q=${encodeURIComponent(q)}&limit=48`).then((r: any) =>
      setResults(r.results || [])
    );
  }, [q]);
  return (
    <section className="row">
      <h2>Results for "{esc(q)}"</h2>
      <div className="grid">{results.map(Card)}</div>
      {results.length === 0 && <p className="muted">No results.</p>}
    </section>
  );
}

function OfflinePage({ id }: { id: string }) {
  const { getDownload } = useDownloads();
  const [record, setRecord] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    getDownload(id).then((r: any) => {
      if (!mounted) return;
      if (!r) setError('Download not found.');
      else setRecord(r);
    });
    return () => { mounted = false; };
  }, [id]);
  if (error) return <p className="muted">{error}</p>;
  if (!record) return <p className="muted">Loading...</p>;
  const blob = new Blob([record.combinedMaster], {
    type: 'application/vnd.apple.mpegurl',
  });
  const url = URL.createObjectURL(blob);
  return (
    <section className="watch">
      <h1>{esc(record.title)}</h1>
      <Player
        poster={record.poster}
        videoSource={url}
        title={record.title}
        id={record.id}
        raw={false}
        onDownload={() => {}}
      />
    </section>
  );
}

export default function App() {
  const [path, setPath] = useState(() =>
    location.hash.replace(/^#\/?/, '')
  );
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<React.ReactNode>(null);

  useEffect(() => {
    const onHashChange = () => {
      setPath(location.hash.replace(/^#\/?/, ''));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const parts = path.split('/').filter(Boolean);
    const renderPage = async () => {
      try {
        let node: React.ReactNode = null;
        if (parts.length === 0) {
          node = <HomePage />;
        } else if (parts[0] === 'feed') {
          const kind = parts[1] || 'newest';
          node = <FeedPage kind={kind} />;
        } else if (parts[0] === 'categories') {
          node = <CategoriesPage />;
        } else if (parts[0] === 'series') {
          const slug = parts[1];
          node = <SeriesPage slug={slug} />;
        } else if (parts[0] === 'seasons') {
          const slug = parts[1];
          const season = parts[2];
          node = (
            <SeasonsPage slug={slug} season={season} />
          );
        } else if (parts[0] === 'episode') {
          const slug = parts[1];
          node = <EpisodePage slug={slug} />;
        } else if (parts[0] === 'watch') {
          const url = decodeURIComponent(parts.slice(1).join('/'));
          node = <WatchPage url={url} />;
        } else if (parts[0] === 'search') {
          const q = decodeURIComponent(parts.slice(1).join('/'));
          node = <SearchPage q={q} />;
        } else if (parts[0] === 'downloads') {
          node = <Downloads />;
        } else if (parts[0] === 'offline') {
          const id = decodeURIComponent(parts[1]);
          node = <OfflinePage id={id} />;
        } else {
          node = <HomePage />;
        }
        if (!cancelled) setPage(node);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    };
    renderPage();
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <>
      <header className="nav">
        <a className="brand" href="#/">
          Anime<b>World</b>
        </a>
        <nav className="links">
          <a href="#/">Home</a>
          <a href="#/feed/newest">New</a>
          <a href="#/feed/trending">Trending</a>
          <a href="#/feed/movies">Movies</a>
          <a href="#/categories">Genres</a>
          <a href="#/downloads">Downloads</a>
        </nav>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = (e.target as any).q.value.trim();
            if (q) location.hash = '#/search/' + encodeURIComponent(q);
          }}
        >
          <input
            name="q"
            type="search"
            placeholder="Search anime..."
            autoComplete="off"
          />
          <button type="submit">Search</button>
        </form>
      </header>
      <main>{error ? <p className="error">Error: {esc(error)}</p> : page}</main>
      <footer className="foot">
        AnimeWorld clone &middot; data proxied from watchanimeworld.one &middot;{' '}
        streaming via zephyrix player
      </footer>
    </>
  );
}
