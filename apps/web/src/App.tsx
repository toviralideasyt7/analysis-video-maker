import React, { useCallback, useState } from 'react';

/**
 * Upload a data file, get a data-race video.
 *
 * The browser posts the file to the uploader service; the service commits it to
 * the GitHub repository and dispatches the render. The MP4 appears as a
 * workflow artifact. No accounts, no research, no settings screen.
 */

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8790';

type Phase = 'idle' | 'uploading' | 'done' | 'error';

export default function App(): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string>('');
  const [details, setDetails] = useState<string[]>([]);
  const [runUrl, setRunUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const submit = useCallback(async () => {
    if (!file) return;
    setPhase('uploading');
    setMessage('Uploading and dispatching the render…');
    setDetails([]);
    try {
      const body = new FormData();
      body.append('file', file);
      if (title.trim()) body.append('title', title.trim());
      const response = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        details?: string[];
        warnings?: string[];
        runUrl?: string;
        message?: string;
      };
      if (!response.ok || !payload.ok) {
        setPhase('error');
        setMessage(payload.error ?? `upload failed (HTTP ${response.status})`);
        setDetails([...(payload.details ?? []), ...(payload.warnings ?? [])]);
        return;
      }
      setPhase('done');
      setMessage(payload.message ?? 'rendering');
      setDetails(payload.warnings ?? []);
      setRunUrl(payload.runUrl ?? null);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [file, title]);
  const [topic, setTopic] = useState('');
  const [dataUrl, setDataUrl] = useState('');

  const submitResearch = useCallback(async () => {
    const clean = topic.trim();
    if (!clean) return;
    setPhase('uploading');
    setMessage('Handing the topic to the research agent…');
    setDetails([]);
    try {
      const response = await fetch(`${API_BASE}/api/research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: clean, dataUrl: dataUrl.trim() || undefined }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        runUrl?: string;
        message?: string;
      };
      if (!response.ok || !payload.ok) {
        setPhase('error');
        setMessage(payload.error ?? `research failed (HTTP ${response.status})`);
        return;
      }
      setPhase('done');
      setMessage(payload.message ?? 'research running');
      setRunUrl(payload.runUrl ?? null);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [topic, dataUrl]);


  return (
    <div className="min-h-screen">
      <header className="border-b border-black/10 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#E1251B] flex items-end justify-center gap-[3px] pb-[9px]">
            <span className="w-[3px] h-3 bg-white rounded" />
            <span className="w-[3px] h-5 bg-white rounded" />
            <span className="w-[3px] h-4 bg-white rounded" />
          </div>
          <div>
            <div className="font-extrabold text-ink leading-tight">data-race videos</div>
            <div className="text-xs text-muted">one data file in · one MP4 out</div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        <div
          className={`panel p-8 text-center border-2 border-dashed transition ${dragging ? 'border-accent bg-red-50/40' : 'border-black/15'}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) setFile(dropped);
          }}
        >
          <input
            id="file"
            type="file"
            accept=".json,.csv"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <label htmlFor="file" className="cursor-pointer block">
            <div className="text-lg font-bold text-ink">{file ? file.name : 'Drop your data file here'}</div>
            <div className="text-sm text-muted mt-1">
              {file
                ? `${(file.size / 1024).toFixed(0)} KB — click to choose a different file`
                : 'or click to browse · .json or .csv · up to 20 MB'}
            </div>
          </label>
        </div>

        <div className="panel p-4 space-y-3">
          <label className="block text-sm font-bold text-ink" htmlFor="title">
            Video title <span className="text-muted font-normal">(optional — the file can also carry it)</span>
          </label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="World Population by Country | 1960 - 2024"
            className="w-full text-sm border border-black/15 rounded-lg px-3 py-2 outline-none focus:border-accent"
          />
        </div>

        <button
          disabled={phase === 'uploading' || !file}
          onClick={() => void submit()}
          className="w-full bg-accent text-white font-bold rounded-lg py-3 disabled:opacity-50"
        >
          {phase === 'uploading' ? 'Working…' : 'Make the video'}
        </button>

        {message ? (
          <div className={`panel p-4 text-sm ${phase === 'error' ? 'border-l-4 border-l-accent text-accent' : 'text-ink'}`}>
            <div className="font-bold">{message}</div>
            {details.length > 0 ? (
              <ul className="mt-2 list-disc pl-4 text-xs text-muted space-y-1">
                {details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            ) : null}
            {runUrl ? (
              <a href={runUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-blue-600 underline">
                watch the render run on GitHub Actions
              </a>
            ) : null}
          </div>
        ) : null}

        <section className="panel p-4">
          <h2 className="font-bold text-ink">Or describe a topic — no file needed</h2>
          <p className="text-sm text-muted mt-1">
            The research agent finds the data, writes the input file and starts the render automatically.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input
              className="border border-black/15 bg-white px-3 py-2 text-sm"
              placeholder="Topic, e.g. CO2 emissions by country"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
            <input
              className="border border-black/15 bg-white px-3 py-2 text-sm"
              placeholder="Optional direct data URL (CSV or JSON)"
              value={dataUrl}
              onChange={(event) => setDataUrl(event.target.value)}
            />
          </div>
          <button
            className="mt-3 border border-ink bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            disabled={!topic.trim() || phase === 'uploading'}
            onClick={submitResearch}
            type="button"
          >
            Research and render
          </button>
        </section>

        <details className="panel p-4 text-sm text-muted">
          <summary className="cursor-pointer font-bold text-ink">What format does the file need?</summary>
          <div className="mt-3 space-y-3">
            <p>Everything the video shows comes from this one file: numbers, colors, flags and the fact texts.</p>
            <pre className="bg-surface p-3 rounded text-xs overflow-x-auto">{`{
  "version": "1.0",
  "title": "World Population by Country | 1960 - 2024",
  "metric": "World Population",
  "unit": "people",
  "entities": [
    { "id": "india", "name": "India", "color": "#F15A22",
      "flagCode": "in", "group": "Asia" }
  ],
  "observations": [
    { "entity": "india", "date": "1960", "value": 449000000 }
  ],
  "facts": [
    { "atDate": "2022", "heading": "Eight billion",
      "body": "The world passes eight billion people.",
      "tiles": ["india", "china"] }
  ],
  "groups": [ { "id": "Asia", "label": "Asia", "color": "#E1251B" } ]
}`}</pre>
            <p>
              A CSV works too: columns <code>entity,date,value</code> (plus optional{' '}
              <code>color,flagCode,group</code>), and an optional facts CSV with{' '}
              <code>atDate,heading,body,tiles</code>. Missing flags are filled in automatically during the render.
            </p>
          </div>
        </details>
      </main>
    </div>
  );
}
