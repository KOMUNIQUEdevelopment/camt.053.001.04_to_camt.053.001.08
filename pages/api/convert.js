import formidable from 'formidable'
import fs from 'fs'
import { XMLParser } from 'fast-xml-parser'

export const config = { api: { bodyParser: false } }

const OLD_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"
const NEW_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value != null) return [value]
  return []
}

function buildXmlElement(name, content, attributes = {}) {
  let attrStr = ''
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      attrStr += ` ${key}="${value}"`
    }
  }
  
  if (content === null || content === undefined || content === '') {
    return `<${name}${attrStr}/>`
  }
  
  if (typeof content === 'string' || typeof content === 'number') {
    return `<${name}${attrStr}>${content}</${name}>`
  }
  
  return `<${name}${attrStr}>\n${content}\n</${name}>`
}

function copyElement(element, indent = '  ') {
  if (typeof element === 'string' || typeof element === 'number') {
    return element.toString()
  }
  
  if (typeof element !== 'object' || element === null) {
    return ''
  }
  
  let result = ''
  
  for (const [key, value] of Object.entries(element)) {
    if (key.startsWith('@') || key === '#text') continue
    
    const cleanKey = key.replace(/^.*:/, '') // Remove namespace prefix
    
    if (Array.isArray(value)) {
      for (const item of value) {
        const attrs = item && typeof item === 'object' ? extractAttributes(item) : {}
        const content = getElementContent(item)
        result += `${indent}${buildXmlElement(cleanKey, content, attrs)}\n`
      }
    } else {
      const attrs = value && typeof value === 'object' ? extractAttributes(value) : {}
      const content = getElementContent(value)
      result += `${indent}${buildXmlElement(cleanKey, content, attrs)}\n`
    }
  }
  
  return result.trimEnd()
}

function extractAttributes(obj) {
  if (!obj || typeof obj !== 'object') return {}
  
  const attrs = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@')) {
      attrs[key.substring(1)] = value
    } else if (key === 'Ccy' && typeof value === 'string') {
      attrs.Ccy = value
    }
  }
  return attrs
}

function getElementContent(obj) {
  if (typeof obj === 'string' || typeof obj === 'number') {
    return obj
  }
  
  if (!obj || typeof obj !== 'object') return ''
  
  if (obj['#text']) {
    return obj['#text']
  }
  
  // Handle Amt elements specially
  if (obj.Ccy && obj['#text']) {
    return obj['#text']
  }
  
  // For complex objects, build nested content
  const content = copyElement(obj, '    ')
  return content ? `\n  ${content}\n` : null
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
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: false
    })

    const parsed = parser.parse(xml)
    const document = parsed.Document
    
    if (!document) {
      return res.status(400).send('Invalid CAMT document')
    }

    // Get default description from GrpHdr
    const grpText = document.BkToCstmrStmt?.GrpHdr?.AddtlInf || ''
    
    // Start building the output XML manually
    let output = `<?xml version='1.0' encoding='UTF-8'?>\n`
    output += `<Document xmlns="${NEW_NS}" xmlns:xsi="${XSI_NS}" xsi:schemaLocation="${NEW_NS} camt.053.001.08.xsd">\n`
    
    // Copy BkToCstmrStmt
    output += `  <BkToCstmrStmt>\n`
    
    // Copy GrpHdr exactly
    const grpHdr = document.BkToCstmrStmt.GrpHdr
    output += `    <GrpHdr>\n`
    output += copyElement(grpHdr, '      ')
    output += `\n    </GrpHdr>\n`
    
    // Process Stmt
    const stmt = document.BkToCstmrStmt.Stmt
    output += `    <Stmt>\n`
    
    // Add Stmt elements in correct order
    const stmtOrder = ['Id','ElctrncSeqNb','CreDtTm','FrToDt','CpyDplctInd','Acct']
    for (const key of stmtOrder) {
      if (stmt[key]) {
        const attrs = extractAttributes(stmt[key])
        const content = getElementContent(stmt[key])
        output += `      ${buildXmlElement(key, content, attrs)}\n`
      }
    }
    
    // Add Bal elements
    const balances = ensureArray(stmt.Bal)
    for (const bal of balances) {
      output += `      <Bal>\n`
      output += copyElement(bal, '        ')
      output += `\n      </Bal>\n`
    }
    
    // Process Ntry elements
    const entries = ensureArray(stmt.Ntry)
    for (const entry of entries) {
      output += `      <Ntry>\n`
      
      // Add Ntry elements in correct order
      const ntryOrder = ['NtryRef','Amt','CdtDbtInd','RvslInd','Sts','BookgDt','ValDt','AcctSvcrRef','BkTxCd','NtryDtls','AddtlNtryInf']
      
      for (const key of ntryOrder) {
        if (entry[key]) {
          if (key === 'Amt') {
            const ccy = entry[key].Ccy || entry[key]['@Ccy']
            const amount = entry[key]['#text'] || entry[key]
            output += `        <Amt Ccy="${ccy}">${amount}</Amt>\n`
          } else if (key === 'NtryDtls') {
            output += `        <NtryDtls>\n`
            const txDtls = entry[key].TxDtls
            if (txDtls) {
              output += `          <TxDtls>\n`
              
              // Process TxDtls in correct order
              const txOrder = ['Refs','Amt','CdtDbtInd','AmtDtls','BkTxCd','RltdPties','RltdAgts','RmtInf']
              
              for (const txKey of txOrder) {
                if (txDtls[txKey]) {
                  if (txKey === 'Amt') {
                    const ccy = txDtls[txKey].Ccy || txDtls[txKey]['@Ccy']
                    const amount = txDtls[txKey]['#text'] || txDtls[txKey]
                    output += `            <Amt Ccy="${ccy}">${amount}</Amt>\n`
                  } else if (txKey === 'AmtDtls') {
                    output += `            <AmtDtls>\n`
                    const instdAmt = txDtls[txKey].InstdAmt
                    if (instdAmt) {
                      const ccy = instdAmt.Ccy || instdAmt['@Ccy']
                      const amount = instdAmt['#text'] || instdAmt
                      output += `              <InstdAmt Ccy="${ccy}">${amount}</InstdAmt>\n`
                    }
                    output += `            </AmtDtls>\n`
                  } else if (txKey === 'RltdAgts') {
                    output += `            <RltdAgts/>\n`
                  } else {
                    output += `            ${buildXmlElement(txKey, copyElement(txDtls[txKey], '              '))}\n`
                  }
                }
              }
              
              // Add missing AmtDtls if not present
              if (!txDtls.AmtDtls && txDtls.Amt) {
                const ccy = txDtls.Amt.Ccy || txDtls.Amt['@Ccy']
                const amount = txDtls.Amt['#text'] || txDtls.Amt
                output += `            <AmtDtls>\n`
                output += `              <InstdAmt Ccy="${ccy}">${amount}</InstdAmt>\n`
                output += `            </AmtDtls>\n`
              }
              
              // Add missing RltdAgts if not present
              if (!txDtls.RltdAgts) {
                output += `            <RltdAgts/>\n`
              }
              
              output += `          </TxDtls>\n`
            }
            output += `        </NtryDtls>\n`
          } else {
            const attrs = extractAttributes(entry[key])
            const content = getElementContent(entry[key])
            output += `        ${buildXmlElement(key, content, attrs)}\n`
          }
        }
      }
      
      // Add missing AmtDtls at Ntry level
      if (!entry.AmtDtls && entry.Amt) {
        output += `        <AmtDtls>\n`
        output += `          <InstdAmt>\n`
        const ccy = entry.Amt.Ccy || entry.Amt['@Ccy']
        const amount = entry.Amt['#text'] || entry.Amt
        output += `            <Amt Ccy="${ccy}">${amount}</Amt>\n`
        output += `          </InstdAmt>\n`
        output += `        </AmtDtls>\n`
      }
      
      // Add missing AddtlNtryInf
      if (!entry.AddtlNtryInf) {
        output += `        <AddtlNtryInf>${grpText}</AddtlNtryInf>\n`
      }
      
      output += `      </Ntry>\n`
    }
    
    output += `    </Stmt>\n`
    output += `  </BkToCstmrStmt>\n`
    output += `</Document>\n`

    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', 'attachment; filename="converted.xml"')
    res.status(200).send(output)

  } catch (error) {
    console.error('Conversion error:', error)
    res.status(500).send('Conversion failed: ' + error.message)
  }
}
