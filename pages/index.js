import { useState } from 'react';

export default function Home() {
  const [file, setFile] = useState(null);
  const [convertedFile, setConvertedFile] = useState(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
  };

  const handleConvert = async () => {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/convert', {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      setConvertedFile(url);
    } else {
      alert('Fehler bei der Konvertierung');
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h1>camt.053.001.04 → .08 Converter</h1>
      <input type="file" accept=".xml" onChange={handleFileChange} />
      <button onClick={handleConvert} disabled={!file}>
        Konvertieren
      </button>
      {convertedFile && (
        <p>
          <a href={convertedFile} download="converted.xml">
            Download converted file
          </a>
        </p>
      )}
    </div>
  );
}
