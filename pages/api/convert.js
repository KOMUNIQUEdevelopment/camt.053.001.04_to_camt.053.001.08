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
  
  // Erst die Reihenfolge-Tags
  order.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Dann die Multi-Tags
  multi.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Dann alle anderen
  Object.keys(obj).forEach(key => {
    if (!order.includes(key) && !multi.includes(key)) {
      result[key] = obj[key]
    }
  })
  
  return result
}

function normalizeRltdPties(tx, oldNtry) {
  // RltdPties aus TxDtls entfernen falls vorhanden
  delete tx.RltdPties
  
  const oldRltdPties = oldNtry.RltdPties
  if (!oldRltdPties) return
  
  const newRltdPties = copyWithNewNamespace(oldRltdPties)
  
  // Dbtr* → Cdtr* transformieren
  if (newRltdPties.DbtrAcct) {
    newRltdPties.CdtrAcct = newRltdPties.DbtrAcct
    delete newRltdPties.DbtrAcct
  }
  
  if (newRltdPties.Dbtr) {
    newRltdPties.Cdtr = newRltdPties.Dbtr
    delete newRltdPties.Dbtr
  }
  
  // Pty wrapper hinzufügen falls nicht vorhanden
  if (newRltdPties.Cdtr && !newRltdPties.Cdtr.Pty) {
    const cdtrContent = { ...newRltdPties.Cdtr }
    newRltdPties.Cdtr = { Pty: cdtrContent }
  }
  
  // Adresse normalisieren
  const pstlAdr = newRltdPties.Cdtr?.Pty?.PstlAdr
  if (pstlAdr && pstlAdr.AdrLine) {
    const adrLines = ensureArray(pstlAdr.AdrLine)
    if (adrLines.length > 0 && !pstlAdr.StrtNm) {
      pstlAdr.StrtNm = adrLines[0]
    }
    delete pstlAdr.AdrLine
  }
  
  // RltdPties Reihenfolge: Cdtr, CdtrAcct
  const orderedRltdPties = {}
  if (newRltdPties.Cdtr) orderedRltdPties.Cdtr = newRltdPties.Cdtr
  if (newRltdPties.CdtrAcct) orderedRltdPties.CdtrAcct = newRltdPties.CdtrAcct
  
  tx.RltdPties = orderedRltdPties
}

function copyRmtInf(tx, oldNtry, grpText) {
  if (!tx.RmtInf) tx.RmtInf = {}
  
  // Füge immer Ustrd hinzu mit GrpHdr AddtlInf
  const ustrdArray = []
  
  // Alte RmtInf kopieren falls vorhanden
  const oldRmtInf = oldNtry.NtryDtls?.TxDtls?.RmtInf || oldNtry.RmtInf
  if (oldRmtInf) {
    const oldUstrd = ensureArray(oldRmtInf.Ustrd)
    ustrdArray.push(...oldUstrd)
    
    // Strd → Ustrd konvertieren
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
  
  // GrpHdr AddtlInf hinzufügen
  if (grpText) {
    ustrdArray.push(grpText)
  }
  
  tx.RmtInf.Ustrd = ustrdArray.length > 1 ? ustrdArray : ustrdArray[0] || grpText
}

export default async function handler(req, res) {
  try {
    const form = new formidable.IncomingForm()
    
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) =>
        err ? reject(err) : resolve({ fields, files })
      )
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
    
    // GrpHdr AddtlInf extrahieren
    const grpText = srcDoc.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || ''
    
    const oldStmt = srcDoc.Document?.BkToCstmrStmt
    if (!oldStmt) {
      return res.status(400).send('No BkToCstmrStmt found')
    }

    // Neues Dokument erstellen
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
    
    // Stmt sortieren
    newDoc.Document.BkToCstmrStmt.Stmt = reorderObject(newStmt, STMT_ORDER, STMT_MULTI)
    
    // Entries verarbeiten
    const oldEntries = ensureArray(oldStmt.Stmt.Ntry)
    const newEntries = ensureArray(newDoc.Document.BkToCstmrStmt.Stmt.Ntry)
    
    for (let i = 0; i < oldEntries.length && i < newEntries.length; i++) {
      const oldNtry = oldEntries[i]
      const newNtry = newEntries[i]
      
      // Ntry sortieren
      newEntries[i] = reorderObject(newNtry, NTRY_ORDER)
      
      // TxDtls verarbeiten
      const tx = newEntries[i].NtryDtls?.TxDtls
      if (tx) {
        // TxDtls sortieren
        newEntries[i].NtryDtls.TxDtls = reorderObject(tx, TX_ORDER)
        const sortedTx = newEntries[i].NtryDtls.TxDtls
        
        // AmtDtls hinzufügen falls fehlend
        if (!sortedTx.AmtDtls && sortedTx.Amt) {
          sortedTx.AmtDtls = {
            InstdAmt: {
              '@Ccy': sortedTx.Amt.Ccy || sortedTx.Amt['@Ccy'],
              '#text': sortedTx.Amt['#text'] || sortedTx.Amt
            }
          }
        }
        
        // RltdPties normalisieren
        normalizeRltdPties(sortedTx, oldNtry)
        
        // RltdAgts hinzufügen (leer falls nicht vorhanden)
        if (!sortedTx.RltdAgts) {
          sortedTx.RltdAgts = oldNtry.RltdAgts ? copyWithNewNamespace(oldNtry.RltdAgts) : {}
        }
        
        // RmtInf kopieren
        copyRmtInf(sortedTx, oldNtry, grpText)
      }
      
      // AddtlNtryInf hinzufügen falls fehlend
      if (!newEntries[i].AddtlNtryInf) {
        newEntries[i].AddtlNtryInf = grpText
      }
    }
    
    // Update the array in the document
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
