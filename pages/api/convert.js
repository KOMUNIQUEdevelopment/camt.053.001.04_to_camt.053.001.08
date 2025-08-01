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

function copyWithNewNamespace(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(copyWithNewNamespace)
  
  const result = {}
  Object.keys(obj).forEach(key => {
    result[key] = copyWithNewNamespace(obj[key])
  })
  return result
}

function reorderObject(obj, order, multi = []) {
  const result = {}
  
  // Erst die Reihenfolge-Elemente
  order.forEach(key => {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  })
  
  // Dann die Multi-Elemente
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
      attributeNamePrefix: '@',
      textNodeName: '#text',
      preserveOrder: false
    })

    const parsed = parser.parse(xml)
    
    // Extrahiere GrpHdr AddtlInf für Beschreibung
    const grpText = parsed?.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || 'SPS/1.7.1/PROD'
    
    // Kopiere Struktur
    const copied = copyWithNewNamespace(parsed)
    const stmt = copied.Document.BkToCstmrStmt.Stmt
    
    // Reorder Stmt
    copied.Document.BkToCstmrStmt.Stmt = reorderObject(stmt, STMT_ORDER, STMT_MULTI)
    
    // Process Entries
    const entries = ensureArray(copied.Document.BkToCstmrStmt.Stmt.Ntry)
    copied.Document.BkToCstmrStmt.Stmt.Ntry = entries.map(entry => {
      // Reorder Entry
      const reorderedEntry = reorderObject(entry, NTRY_ORDER)
      
      // Process TxDtls
      if (reorderedEntry.NtryDtls?.TxDtls) {
        const tx = reorderedEntry.NtryDtls.TxDtls
        
        // Reorder TxDtls
        const reorderedTx = reorderObject(tx, TX_ORDER)
        
        // Add missing AmtDtls in TxDtls
        if (!reorderedTx.AmtDtls && reorderedTx.Amt) {
          reorderedTx.AmtDtls = {
            InstdAmt: {
              '@Ccy': reorderedTx.Amt['@Ccy'],
              '#text': reorderedTx.Amt['#text']
            }
          }
        }
        
        // Fix RmtInf - add second Ustrd
        if (reorderedTx.RmtInf) {
          const existingUstrd = reorderedTx.RmtInf.Ustrd
          reorderedTx.RmtInf.Ustrd = [
            existingUstrd,
            grpText
          ]
        } else {
          reorderedTx.RmtInf = {
            Ustrd: [grpText, grpText]
          }
        }
        
        // Fix RltdPties structure
        if (reorderedTx.RltdPties) {
          const parties = reorderedTx.RltdPties
          
          // Transform DbtrAcct -> CdtrAcct if needed
          if (parties.DbtrAcct) {
            parties.CdtrAcct = parties.DbtrAcct
            delete parties.DbtrAcct
          }
          
          // Wrap Cdtr content in Pty if needed
          if (parties.Cdtr && !parties.Cdtr.Pty) {
            const cdtrContent = { ...parties.Cdtr }
            parties.Cdtr = { Pty: cdtrContent }
          }
        }
        
        // Add empty RltdAgts
        if (!reorderedTx.RltdAgts) {
          reorderedTx.RltdAgts = {}
        }
        
        reorderedEntry.NtryDtls.TxDtls = reorderedTx
      }
      
      // Add AddtlNtryInf if missing
      if (!reorderedEntry.AddtlNtryInf) {
        reorderedEntry.AddtlNtryInf = grpText
      }
      
      return reorderedEntry
    })

    // Baue finales Dokument
    const outputDoc = {
      Document: {
        '@xmlns': NEW_NS,
        '@xmlns:xsi': XSI_NS,
        '@xsi:schemaLocation': `${NEW_NS} camt.053.001.08.xsd`,
        BkToCstmrStmt: copied.Document.BkToCstmrStmt
      }
    }

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: false
    })

    const xmlOutput = builder.build(outputDoc)
    
    // **NUR eine XML-Deklaration hinzufügen**
    const finalXml = `<?xml version='1.0' encoding='UTF-8'?>\n${xmlOutput}`

    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', 'attachment; filename="converted_camt.xml"')
    res.status(200).send(finalXml)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
