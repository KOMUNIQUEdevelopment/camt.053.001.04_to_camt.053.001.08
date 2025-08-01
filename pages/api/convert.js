import formidable from 'formidable'
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

  const xml = fs.readFileSync(files.file.filepath, 'utf8')
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: false
  })

  let json = parser.parse(xml)

  // 🔧 Fix: konvertiere bestimmte Attribute zu Child-Elementen
  const fixTxDtls = (jsonNode) => {
    if (!jsonNode?.BkToCstmrStmt?.Stmt?.Ntry) return

    const entries = Array.isArray(jsonNode.BkToCstmrStmt.Stmt.Ntry)
      ? jsonNode.BkToCstmrStmt.Stmt.Ntry
      : [jsonNode.BkToCstmrStmt.Stmt.Ntry]

    entries.forEach(entry => {
      if (!entry.NtryDtls?.TxDtls) return

      const txList = Array.isArray(entry.NtryDtls.TxDtls)
        ? entry.NtryDtls.TxDtls
        : [entry.NtryDtls.TxDtls]

      txList.forEach(tx => {
        // Verschiebe CdtDbtInd aus Attribut zu Element
        if (tx.CdtDbtInd) return // schon als Element vorhanden
        if (tx.CdtDbtInd === undefined && tx['CdtDbtInd']) {
          tx.CdtDbtInd = tx['CdtDbtInd']
          delete tx['CdtDbtInd']
        }
        if (tx.CdtDbtInd === undefined && tx.CdtDbtIndAttr) {
          tx.CdtDbtInd = tx.CdtDbtIndAttr
          delete tx.CdtDbtIndAttr
        }

        // Falls AcctSvcrRef als Attribut in Refs ist, konvertiere zu Child-Element
        if (tx.Refs && tx.Refs.AcctSvcrRef && typeof tx.Refs.AcctSvcrRef === 'string') {
          tx.Refs = {
            AcctSvcrRef: tx.Refs.AcctSvcrRef
          }
        }
      })
    })
  }

  fixTxDtls(json)

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    format: true
  })
  const outputXml = builder.build(json)

  res.setHeader('Content-Type', 'application/xml')
  res.status(200).send(outputXml)
}
