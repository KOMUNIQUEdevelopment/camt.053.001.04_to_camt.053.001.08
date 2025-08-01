import formidable from 'formidable'
import fs from 'fs'

export const config = {
  api: {
    bodyParser: false
  }
}

export default async function handler(req, res) {
  try {
    const form = new formidable.IncomingForm()
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }))
    })

    // Stelle sicher, dass wir die Datei wirklich bekommen
    if (!files.file) {
      res.status(400).send('No file uploaded')
      return
    }

    // Pfad (je nach neuer/formidable-Version)
    const filePath = files.file.filepath || files.file.path
    if (!fs.existsSync(filePath)) {
      res.status(400).send(`File not found: ${filePath}`)
      return
    }

    // Lese den rohen XML-Content
    const xml = fs.readFileSync(filePath, 'utf8')

    // Sende ihn 1:1 zurück (zum Testen)
    res.setHeader('Content-Type', 'application/xml')
    res.status(200).send(xml)
  } catch (err) {
    console.error('🔥 Error in /api/convert:', err)
    res.status(500).send(`Server error: ${err.message}`)
  }
}
