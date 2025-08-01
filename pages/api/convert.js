import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = {
  api: { bodyParser: false }
}

export default async function handler(req, res) {
  const form = new formidable.IncomingForm()

  const { files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    )
  })

  const xml = fs.readFileSync(files.file.filepath, 'utf8')

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: false
  })

  let json = parser.parse(xml)

  // 🔧 FIX: Attribut zu Element in Refs und TxDtls
  const fixTxDetails = () => {
    const entries = json?.Document?.BkToCstmrStmt?.Stmt?.Ntry
    if (!entries) return

    const entryList = Array.isArray(entries) ? entries : [entries]

    entryList.forEach((entry) => {
      const txDtlsList = entry?.NtryDtls?.TxDtls
      if (!txDtlsList) return

      const txs = Array.isArray(txDtlsList) ? txDtlsList : [txDtlsList]

      txs.forEach((tx) => {
        // 👇 Stelle sicher, dass AcctSvcrRef ein Element ist
        if (tx.Refs && typeof tx.Refs.AcctSvcrRef === 'string') {
          tx.Refs = {
            AcctSvcrRef: {
              '#text': tx.Refs.AcctSvcrRef
            }
          }
        }

        // 👇 Dasselbe für CdtDbtInd falls notwendig
        if (typeof tx.CdtDbtInd === 'string') {
          tx.CdtDbtInd = { '#text': tx.CdtDbtInd }
        }
      })
    })
  }

  fixTxDetails()

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    format: true
  })

  const outputXml = builder.build(json)

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(outputXml)
}
