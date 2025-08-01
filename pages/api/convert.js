// pages/api/convert.js

import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = {
  api: { bodyParser: false }
}

// Namespaces und Sortier-Arrays
const OLD_NS     = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.04'
const NEW_NS     = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08'
const XSI_NS     = 'http://www.w3.org/2001/XMLSchema-instance'
const STMT_ORDER = ['Id','ElctrncSeqNb','CreDtTm','FrToDt','CpyDplctInd','Acct']
const STMT_MULTI = ['Bal','Ntry']
const NTRY_ORDER = ['NtryRef','Amt','CdtDbtInd','RvslInd','Sts','BookgDt','ValDt','AcctSvcrRef','BkTxCd','NtryDtls','AddtlNtryInf']
const TX_ORDER   = ['Refs','Amt','CdtDbtInd','AmtDtls','BkTxCd','RltdPties','RltdAgts','RmtInf']

function ensureArray(v) {
  if (Array.isArray(v)) return v
  if (v != null) return [v]
  return []
}

function reorderObject(obj, order, multi = []) {
  const out = {}
  order.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k] })
  multi.forEach(k =>  { if (obj[k] !== undefined) out[k] = obj[k] })
  Object.keys(obj)
    .filter(k => !order.includes(k) && !multi.includes(k))
    .forEach(k => { out[k] = obj[k] })
  return out
}

export default async function handler(req, res) {
  try {
    // 1) Multipart-Formular parsen
    const form = new formidable.IncomingForm()
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) =>
        err ? reject(err) : resolve({ fields, files })
      )
    })
    const file = files.file
    if (!file) {
      res.status(400).send('No file uploaded')
      return
    }
    const path = file.filepath || file.path
    if (!fs.existsSync(path)) {
      res.status(400).send(`File not found: ${path}`)
      return
    }

    // 2) XML einlesen und parsen
    const xml = fs.readFileSync(path, 'utf8')
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    const docJson = parser.parse(xml)

    // 3) Fallback-Text aus GrpHdr/AddtlInf
    const grpText = (docJson.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf) || ''

    // 4) <Stmt> neu sortieren
    const stmtIn  = docJson.Document.BkToCstmrStmt.Stmt
    const newStmt = reorderObject(stmtIn, STMT_ORDER, STMT_MULTI)

    // 5) Jede Buchung (<Ntry>) transformieren
    const oldEntries = ensureArray(stmtIn.Ntry)
    newStmt.Ntry = oldEntries.map(oldN => {
      const n = {}
      // 5a) Ntry-Felder in Reihenfolge
      NTRY_ORDER.forEach(tag => {
        if (tag === 'NtryDtls') {
          if (oldN.NtryDtls) n.NtryDtls = oldN.NtryDtls
        } else if (tag === 'AddtlNtryInf') {
          n.AddtlNtryInf = oldN.AddtlNtryInf || grpText
        } else if (oldN[tag] !== undefined) {
          n[tag] = oldN[tag]
        }
      })
      // 5b) TxDtls transformieren & Fallbacks
      if (n.NtryDtls?.TxDtls) {
        const txIn  = n.NtryDtls.TxDtls
        const newTx = reorderObject(txIn, TX_ORDER)
        if (!newTx.AmtDtls && txIn.Amt) {
          newTx.AmtDtls = {
            InstdAmt: {
              '#text': txIn.Amt['#text'],
              Ccy:     txIn.Amt.Ccy
            }
          }
        }
        if (!newTx.RmtInf) {
          newTx.RmtInf = { Ustrd: n.AddtlNtryInf }
        }
        if (!newTx.RltdPties && oldN.RltdPties) newTx.RltdPties = oldN.RltdPties
        if (!newTx.RltdAgts  && oldN.RltdAgts ) newTx.RltdAgts  = oldN.RltdAgts
        if (!newTx.BkTxCd    && oldN.BkTxCd   ) newTx.BkTxCd    = oldN.BkTxCd
        n.NtryDtls.TxDtls = newTx
      }
      return n
    })

    // 6) Neuer JSON-Baum für XML
    const outJson = {
      Document: {
        xmlns:              NEW_NS,
        'xmlns:xsi':        XSI_NS,
        'xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
        BkToCstmrStmt: {
          GrpHdr: docJson.Document.BkToCstmrStmt.GrpHdr,
          Stmt:   newStmt
        }
      }
    }

    // 7) XML bauen mit Deklaration & Pretty-Print
    const builder = new XMLBuilder({
      ignoreAttributes:    false,
      attributeNamePrefix: '',
      declaration: {
        include:  true,
        encoding: 'UTF-8',
        version:  '1.0'
      },
      format:            true,
      indentBy:          '  ',
      suppressEmptyNode: false
    })
    let outXml = builder.build(outJson)

    // 8) Anpassung der Deklaration auf einfache Anführungszeichen & Leerzeile
    outXml = outXml.replace(/^\<\?xml .*?\?\>/, decl => decl.replace(/\"/g, \"'\") + \"\n\")

    // 9) Abschließender Zeilenumbruch
    res.setHeader('Content-Type', 'application/xml')
    res.status(200).send(outXml + '\n')

  } catch (err) {
    console.error('Error in /api/convert:', err)
    res.status(500).send('Server error')
  }
}
