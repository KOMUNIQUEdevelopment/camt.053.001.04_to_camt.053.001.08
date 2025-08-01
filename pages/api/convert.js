import formidable from 'formidable'
import fs from 'fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

const OLD_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"
const NEW_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

const STMT_ORDER = ['Id','ElctrncSeqNb','CreDtTm','FrToDt','CpyDplctInd','Acct']
const STMT_MULTI = ['Bal','Ntry']
const NTRY_ORDER = ['NtryRef','Amt','CdtDbtInd','RvslInd','Sts','BookgDt','ValDt','AcctSvcrRef','BkTxCd','NtryDtls','AmtDtls','AddtlNtryInf']
const TX_ORDER = ['Refs','Amt','CdtDbtInd','BkTxCd','RmtInf','AmtDtls','RltdPties','RltdAgts']

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value != null) return [value]
  return []
}

function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(deepCopy)
  
  const copy = {}
  for (const [key, value] of Object.entries(obj)) {
    copy[key] = deepCopy(value)
  }
  return copy
}

function reorderObject(obj, order, multi = []) {
  const result = {}
  
  // Erst die geordneten Felder
  order.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Dann die Multi-Felder
  multi.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Schließlich alle anderen
  Object.keys(obj).forEach(key => {
    if (!order.includes(key) && !multi.includes(key)) {
      result[key] = obj[key]
    }
  })
  
  return result
}

function fixAmountAttributes(obj) {
  if (!obj || typeof obj !== 'object') return obj
  
  if (Array.isArray(obj)) {
    return obj.map(fixAmountAttributes)
  }
  
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'Amt' && value && typeof value === 'object' && value['#text'] && value['Ccy']) {
      // Konvertiere zu Attribut-Format
      result[key] = {
        '#text': value['#text'],
        '@_Ccy': value['Ccy']
      }
    } else if (key === 'InstdAmt' && value && typeof value === 'object' && value['#text'] && value['Ccy']) {
      // Für InstdAmt auch Attribut-Format
      result[key] = {
        '#text': value['#text'],
        '@_Ccy': value['Ccy']
      }
    } else {
      result[key] = fixAmountAttributes(value)
    }
  }
  return result
}

function transformRltdPties(rltdPties) {
  if (!rltdPties) return null
  
  const result = {}
  
  // DbtrAcct -> CdtrAcct
  if (rltdPties.DbtrAcct) {
    result.CdtrAcct = rltdPties.DbtrAcct
  }
  
  // Cdtr mit Pty wrapper
  if (rltdPties.Cdtr) {
    result.Cdtr = {
      Pty: {
        Nm: rltdPties.Cdtr.Nm,
        ...(rltdPties.Cdtr.PstlAdr && { PstlAdr: rltdPties.Cdtr.PstlAdr })
      }
    }
  }
  
  return result
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
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      preserveOrder: false
    })

    const json = parser.parse(xml)
    
    // Get AddtlInf from GrpHdr for default description
    const grpText = json?.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || 'SPS/1.7.1/PROD'
    
    // Deep copy and transform
    let newJson = deepCopy(json)
    
    // Update namespaces
    newJson.Document['@_xmlns'] = NEW_NS
    newJson.Document['@_xmlns:xsi'] = XSI_NS
    newJson.Document['@_xsi:schemaLocation'] = `${NEW_NS} camt.053.001.08.xsd`
    
    // Fix LastPgInd - sollte "true" Text haben, nicht empty
    if (newJson.Document?.BkToCstmrStmt?.GrpHdr?.MsgPgntn?.LastPgInd !== undefined) {
      newJson.Document.BkToCstmrStmt.GrpHdr.MsgPgntn.LastPgInd = 'true'
    }
    
    // Process Stmt
    const stmt = newJson.Document.BkToCstmrStmt.Stmt
    if (stmt) {
      // Reorder Stmt
      newJson.Document.BkToCstmrStmt.Stmt = reorderObject(stmt, STMT_ORDER, STMT_MULTI)
      
      // Process Entries
      const entries = ensureArray(newJson.Document.BkToCstmrStmt.Stmt.Ntry)
      newJson.Document.BkToCstmrStmt.Stmt.Ntry = entries.map(entry => {
        // Reorder Ntry
        const reorderedEntry = reorderObject(entry, NTRY_ORDER)
        
        // Process TxDtls
        if (reorderedEntry.NtryDtls?.TxDtls) {
          const tx = reorderedEntry.NtryDtls.TxDtls
          
          // Transform RltdPties
          if (tx.RltdPties) {
            tx.RltdPties = transformRltdPties(tx.RltdPties)
          }
          
          // Add missing RmtInf second Ustrd
          if (tx.RmtInf) {
            if (typeof tx.RmtInf.Ustrd === 'string') {
              tx.RmtInf.Ustrd = [tx.RmtInf.Ustrd, grpText]
            } else if (Array.isArray(tx.RmtInf.Ustrd) && tx.RmtInf.Ustrd.length === 1) {
              tx.RmtInf.Ustrd.push(grpText)
            }
          }
          
          // Add empty RltdAgts if missing
          if (!tx.RltdAgts) {
            tx.RltdAgts = null // Dies wird zu <RltdAgts/> 
          }
          
          // Reorder TxDtls
          reorderedEntry.NtryDtls.TxDtls = reorderObject(tx, TX_ORDER)
        }
        
        // Ensure AddtlNtryInf exists
        if (!reorderedEntry.AddtlNtryInf) {
          reorderedEntry.AddtlNtryInf = grpText
        }
        
        return reorderedEntry
      })
    }
    
    // Fix amount attributes
    newJson = fixAmountAttributes(newJson)
    
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: false,
      suppressBooleanAttributes: false
    })

    const xmlOutput = builder.build(newJson)
    const declaration = `<?xml version='1.0' encoding='UTF-8'?>\n`
    
    res.setHeader('Content-Type', 'application/xml')
    res.status(200).send(declaration + xmlOutput)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
