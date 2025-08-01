import formidable from 'formidable-serverless'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  const form = new formidable.IncomingForm()
  const { files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    )
  })

  const xml = fs.readFileSync(files.file.path, 'utf8')
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const json = parser.parse(xml)

  // TODO: Hier die Transformation implementieren,
  // analog zum Python-Skript (Umbenennen/Namensraum/etc.)

  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '' })
  const outputXml = builder.build(json)

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(outputXml)
}
