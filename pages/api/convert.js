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

function reorderObject(obj, order, multi = []) {
  const result = {}
  
  // Zuerst die geordneten Felder
  order.forEach(key => {
    if (obj.hasOwnProperty(key)) {
      result[key] = obj[key]
    }
  })
  
  // Dann die Multi-Felder
  multi.forEach(key => {
    if (obj.hasOwnProperty(key)) {
      result[key] = obj[key]
    }
  })
  
  // Schließlich alle anderen Felder
  Object.keys(obj).forEach(key => {
    if (!order.includes(key) && !multi.includes(key)) {
      result[key] = obj[key]
    }
  })
  
  return result
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

function fixAttributeFormat(obj) {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(fixAttributeFormat)
  
  const result = {}
  Object.keys(obj).forEach(key => {
    if (key === 'Amt' && obj[key] && typeof obj[key] === 'object' && obj[key]['#text'] && obj[key]['Ccy']) {
      // Konvertiere <Amt><#text>9</#text><Ccy>CHF</Ccy></Amt> zu <Amt Ccy="CHF">9</Amt>
      result[key] = {
        '#text': obj[key]['#text'],
        '@_Ccy': obj[key]['Ccy']
      }
    } else if (key === 'InstdAmt' && obj[key] && typeof obj[key] === 'object' && obj[key]['#text'] && obj[key]['Ccy']) {
      // Gleiches für InstdAmt
      result[key] = {
        '#text': obj[key]['#text'],
        '@_Ccy': obj[key]['Ccy']
      }
    } else {
      result[key] = fixAttributeFormat(obj[key])
    }
  })
  return result
}

function transformRltdPties(oldEntry) {
  const oldRltdPties = oldEntry.RltdPties
  if (!oldRltdPties) return null
  
  const result = {}
  
  // Dbtr -> Cdtr transformieren
  if (oldRltdPties.Dbtr) {
    result.Cdtr = {
      Pty: oldRltdPties.Dbtr
    }
  }
  
  // DbtrAcct -> CdtrAcct transformieren  
  if (oldRltdPties.DbtrAcct) {
    result.CdtrAcct = oldRltdPties.DbtrAcct
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

    const inputData = parser.parse(xml)
    
    // Extrahiere GrpHdr AddtlInf für Fallback
    const grpHdrInfo = inputData?.Document?.BkToCstmrStmt?.GrpHdr?.AddtlInf || 'SPS/1.7.1/PROD'
    
    // Kopiere und transformiere die Daten
    const outputData = copyWithNewNamespace(inputData)
    
    // Update Namespaces
    outputData.Document['@_xmlns'] = NEW_NS
    outputData.Document['@_xmlns:xsi'] = XSI_NS
    outputData.Document['@_xsi:schemaLocation'] = `${NEW_NS} camt.053.001.08.xsd`
    
    // Verarbeite Statement
    const stmt = outputData.Document.BkToCstmrStmt.Stmt
    const originalEntries = ensureArray(inputData.Document.BkToCstmrStmt.Stmt.Ntry)
    
    // Reorder Statement
    outputData.Document.BkToCstmrStmt.Stmt = reorderObject(stmt, STMT_ORDER, STMT_MULTI)
    
    // Verarbeite Entries
    const newEntries = ensureArray(outputData.Document.BkToCstmrStmt.Stmt.Ntry)
    
    newEntries.forEach((entry, index) => {
      const originalEntry = originalEntries[index]
      
      // Reorder Entry
      const reorderedEntry = reorderObject(entry, NTRY_ORDER)
      
      // Verarbeite TxDtls
      if (reorderedEntry.NtryDtls?.TxDtls) {
        const txDtls = reorderedEntry.NtryDtls.TxDtls
        
        // AmtDtls hinzufügen falls fehlt
        if (!txDtls.AmtDtls && txDtls.Amt) {
          txDtls.AmtDtls = {
            InstdAmt: {
              '#text': txDtls.Amt['#text'] || txDtls.Amt,
              Ccy: txDtls.Amt['@_Ccy'] || txDtls.Amt.Ccy
            }
          }
        }
        
        // RltdPties transformieren
        const transformedRltdPties = transformRltdPties(originalEntry)
        if (transformedRltdPties) {
          txDtls.RltdPties = transformedRltdPties
        }
        
        // RltdAgts hinzufügen (leer)
        if (!txDtls.RltdAgts) {
          txDtls.RltdAgts = null // Wird zu <RltdAgts/>
        }
        
        // RmtInf sicherstellen
        if (!txDtls.RmtInf) {
          txDtls.RmtInf = {
            Ustrd: [grpHdrInfo]
          }
        } else if (txDtls.RmtInf.Ustrd && !Array.isArray(txDtls.RmtInf.Ustrd)) {
          txDtls.RmtInf.Ustrd = [txDtls.RmtInf.Ustrd, grpHdrInfo]
        }
        
        // Reorder TxDtls
        reorderedEntry.NtryDtls.TxDtls = reorderObject(txDtls, TX_ORDER)
      }
      
      // AmtDtls auf Entry-Level hinzufügen
      if (!reorderedEntry.AmtDtls && reorderedEntry.Amt) {
        reorderedEntry.AmtDtls = {
          InstdAmt: {
            Amt: {
              '#text': reorderedEntry.Amt['#text'] || reorderedEntry.Amt,
              Ccy: reorderedEntry.Amt['@_Ccy'] || reorderedEntry.Amt.Ccy
            }
          }
        }
      }
      
      // AddtlNtryInf sicherstellen
      if (!reorderedEntry.AddtlNtryInf) {
        reorderedEntry.AddtlNtryInf = grpHdrInfo
      }
      
      // Entry ersetzen
      Object.keys(entry).forEach(key => delete entry[key])
      Object.assign(entry, reorderedEntry)
    })
    
    // Attribut-Format korrigieren
    const fixedData = fixAttributeFormat(outputData)
    
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: false,
      suppressBooleanAttributes: false
    })

    const xmlOutput = builder.build(fixedData)
    const declaration = "<?xml version='1.0' encoding='UTF-8'?>\n"
    
    res.setHeader('Content-Type', 'application/xml')
    res.status(200).send(declaration + xmlOutput)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
