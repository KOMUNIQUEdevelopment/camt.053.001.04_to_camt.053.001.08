import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

const OLD_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"
const NEW_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

const STMT_ORDER = ['Id','ElctrncSeqNb','CreDtTm','FrToDt','CpyDplctInd','Acct']
const STMT_MULTI = ['Bal','Ntry']
const NTRY_ORDER = ['NtryRef','Amt','CdtDbtInd','RvslInd','Sts','BookgDt','ValDt','AcctSvcrRef','BkTxCd','NtryDtls','AddtlNtryInf']
const TX_ORDER = ['Refs','Amt','CdtDbtInd','AmtDtls','BkTxCd','RltdPties','RltdAgts','RmtInf']

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value != null) return [value]
  return []
}

function copyWithNewNamespace(obj, visited = new Set()) {
  if (obj === null || typeof obj !== 'object') return obj
  if (visited.has(obj)) return obj
  visited.add(obj)

  if (Array.isArray(obj)) {
    return obj.map(item => copyWithNewNamespace(item, visited))
  }

  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    result[key] = copyWithNewNamespace(value, visited)
  }
  return result
}

function reorderObject(obj, order, multi = []) {
  const result = {}

  order.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })

  multi.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })

  Object.keys(obj).forEach(key => {
    if (!order.includes(key) && !multi.includes(key)) {
      result[key] = obj[key]
    }
  })

  return result
}

function normalizeRltdPties(tx, oldNtry) {
  delete tx.RltdPties
  const oldRltdPties = oldNtry.RltdPties
  if (!oldRltdPties) return

  const newRltdPties = copyWithNewNamespace(oldRltdPties)

  if (newRltdPties.DbtrAcct) {
    newRltdPties.CdtrAcct = newRltdPties.DbtrAcct
    delete newRltdPties.DbtrAcct
  }

  if (newRltdPties.Dbtr) {
    newRltdPties.Cdtr = newRltdPties.Dbtr
    delete newRltdPties.Dbtr
  }

  if (newRltdPties.Cdtr && !newRltdPties.Cdtr.Pty) {
    const cdtrContent = { ...newRltdPties.Cdtr }
    newRltdPties.Cdtr = { Pty: cdtrContent }
  }

  const pstlAdr = newRltdPties.Cdtr?.Pty?.PstlAdr
  if (pstlAdr && pstlAdr.AdrLine) {
    const adrLines = ensureArray(pstlAdr.AdrLine)
    if (adrLines.length > 0 && !pstlAdr.StrtNm) {
      pstlAdr.StrtNm = adrLines[0]
    }
    delete pstlAdr.AdrLine
  }

  const orderedRltdPties = {}
  if (newRltdPties.Cdtr) orderedRltdPties.Cdtr = newRltdPties.Cdtr
  if (newRltdPties.CdtrAcct) orderedRltdPties.CdtrAcct = newRltdPties.CdtrAcct

  tx.RltdPties = orderedRltdPties
}

function copyRmtInf(tx, oldNtry, grpText) {
  if (!tx.RmtInf) tx.RmtInf = {}

  const ustrdArray = []

  const oldRmtInf = oldNtry.NtryDtls?.TxDtls?.RmtInf || oldNtry.RmtInf
  if (oldRmtInf) {
    const oldUstrd = ensureArray(oldRmtInf.Ustrd)
    ustrdArray.push(...oldUstrd)

    if (oldRmtInf.Strd) {
      const strdArray = ensureArray(oldRmtInf.Strd)
      strdArray.forEach(strd => {
        if (strd.AddtlRmtInf) {
          const addtlArray = ensureArray(strd.AddtlRmtInf)
          ustrdArray.push(...addtlArray)
        }
      })
    }
  }

  if (grpText) {
    ustrdArray.push(grpText)
  }

  tx.RmtInf.Ustrd = ustrdArray.length > 1 ? ustrdArray : ustrdArray[0] || grpText
}

export default async function handler(req, res) {
  try {
    const form = new formidable.IncomingForm()
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }))
    })

    if (!files.file) {
      return res.status(400).send('No file uploaded')
    }

    const xml = fs.readFileSync(files.file.filepath, 'utf8')

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '#text',
      preserveOrder: false
    })

    const srcDoc = parser.parse(xml)

    const grpText = srcDoc.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || ''
    const oldStmt = srcDoc.Document?.BkToCstmrStmt
    if (!oldStmt) return res.status(400).send('No BkToCstmrStmt found')

    const newDoc = {
      Document: {
        '@xmlns': NEW_NS,
        '@xmlns:xsi': XSI_NS,
        '@xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
        BkToCstmrStmt: {
          GrpHdr: copyWithNewNamespace(oldStmt.GrpHdr),
          Stmt: copyWithNewNamespace(oldStmt.Stmt)
        }
      }
    }

    const newStmt = newDoc.Document.BkToCstmrStmt.Stmt
    newDoc.Document.BkToCstmrStmt.Stmt = reorderObject(newStmt, STMT_ORDER, STMT_MULTI)

    const oldEntries = ensureArray(oldStmt.Stmt.Ntry)
    const newEntries = ensureArray(newDoc.Document.BkToCstmrStmt.Stmt.Ntry)

    for (let i = 0; i < oldEntries.length && i < newEntries.length; i++) {
      const oldNtry = oldEntries[i]
      const newNtry = newEntries[i]

      // Ntry.Amt korrigieren
      if (newNtry.Amt && typeof newNtry.Amt === 'object') {
        const currency = newNtry.Amt['@Ccy'] || newNtry.Amt.Ccy
        const amountText = newNtry.Amt['#text'] || newNtry.Amt
        newNtry.Amt = {
          '@Ccy': currency,
          '#text': amountText
        }
      }

      newEntries[i] = reorderObject(newNtry, NTRY_ORDER)

      const tx = newEntries[i].NtryDtls?.TxDtls
      if (tx) {
        newEntries[i].NtryDtls.TxDtls = reorderObject(tx, TX_ORDER)
        const sortedTx = newEntries[i].NtryDtls.TxDtls

        if (!sortedTx.AmtDtls && sortedTx.Amt) {
          const currency = sortedTx.Amt['@Ccy'] || sortedTx.Amt.Ccy
          const amountText = sortedTx.Amt['#text'] || sortedTx.Amt
          sortedTx.AmtDtls = {
            InstdAmt: {
              '@Ccy': currency,
              '#text': amountText
            }
          }
        }

        normalizeRltdPties(sortedTx, oldNtry)

        if (!sortedTx.RltdAgts) {
          sortedTx.RltdAgts = oldNtry.RltdAgts ? copyWithNewNamespace(oldNtry.RltdAgts) : {}
        }

        copyRmtInf(sortedTx, oldNtry, grpText)
      }

      if (!newEntries[i].AddtlNtryInf) {
        newEntries[i].AddtlNtryInf = grpText
      }
    }

    newDoc.Document.BkToCstmrStmt.Stmt.Ntry = newEntries

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: false
    })

    const xmlOutput = builder.build(newDoc)
    const declaration = "<?xml version='1.0' encoding='UTF-8'?>\n"

    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', 'attachment; filename="converted_camt_08.xml"')
    res.status(200).send(declaration + xmlOutput)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
