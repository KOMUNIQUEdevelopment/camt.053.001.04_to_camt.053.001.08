import { useState } from 'react'

export default function Home() {
  const [file, setFile] = useState(null)
  const [downloadUrl, setDownloadUrl] = useState('')

  const handleUpload = async e => {
    e.preventDefault()
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    const res = await fetch('/api/convert', { method: 'POST', body: formData })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    setDownloadUrl(url)
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>CAMT Converter</h1>
      <form onSubmit={handleUpload}>
        <input type="file" accept=".xml" onChange={e => setFile(e.target.files[0])} />
        <button type="submit">Convert</button>
      </form>
      {downloadUrl && (
        <p>
          <a href={downloadUrl} download="converted.xml">
            Download converted CAMT file
          </a>
        </p>
      )}
    </div>
  )
}
