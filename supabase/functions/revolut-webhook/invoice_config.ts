// invoice_config.ts - IR35 Workbench VAT invoice settings (PAY-05).
// A verbatim copy of Olivia's approved invoice_config.json (17 Sep 2026, Aaron-approved):
//   AI Platform/Orsted IR35 Demo/Invoice Template/invoice_config.json
// Change that file first, then this one. Amounts are integer pence.
export const INVOICE_CONFIG = {
  "supplier": {
    "legal_name": "Ascend People Solutions Ltd",
    "address_lines": [
      "9 Ulysses Road",
      "London",
      "NW6 1ED"
    ],
    "company_number": "15145981",
    "vat_number": "GB 466 0827 74",
    "contact_email": "accounts@ascend-people.com"
  },
  "invoice_number_format": {
    "prefix": "IRW-",
    "pad_to": 6,
    "first_number": 100
  },
  "vat_rate_percent": 20,
  "fee_tiers": {
    "first_assessment": {
      "net_pence": 7500,
      "vat_pence": 1500,
      "gross_pence": 9000,
      "description": "IR35 status assessment \u2014 first assessment"
    },
    "reassessment": {
      "net_pence": 6500,
      "vat_pence": 1300,
      "gross_pence": 7800,
      "description": "IR35 status reassessment"
    }
  }
} as const;
