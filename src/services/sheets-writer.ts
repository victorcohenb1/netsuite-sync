import { google, sheets_v4 } from "googleapis";
import { env } from "../config/env";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "sheets-writer" });

// Types
export interface WriteToSheetParams {
  spreadsheetId: string;
  tabName: string;
  headers: string[];
  rows: Record<string, string>[];
  colorHex?: string | null;
  timeZone?: string;
}

export interface WriteResult {
  rowsWritten: number;
  durationMs: number;
}

// Singleton sheets client
let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!email || !privateKey) {
    throw new Error(
      "Google Service Account credentials not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)",
    );
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// Helper: convert hex color to Google Sheets RGBA
function hexToColor(hex: string): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  const clean = hex.replace("#", "");
  return {
    red: parseInt(clean.substring(0, 2), 16) / 255,
    green: parseInt(clean.substring(2, 4), 16) / 255,
    blue: parseInt(clean.substring(4, 6), 16) / 255,
    alpha: 1,
  };
}

// Helper: convert rows to 2D array (same as Apps Script to2D_)
function to2DArray(
  headers: string[],
  rows: Record<string, string>[],
): string[][] {
  const result: string[][] = [headers];
  for (const row of rows) {
    result.push(
      headers.map((h) => {
        const v = row[h];
        return v === null || v === undefined ? "" : String(v);
      }),
    );
  }
  return result;
}

// Main write function
export async function writeToSheet(
  params: WriteToSheetParams,
): Promise<WriteResult> {
  const start = Date.now();
  const sheets = getSheetsClient();
  const { spreadsheetId, tabName, headers, rows, colorHex, timeZone } = params;

  log.info(
    { spreadsheetId, tabName, rowCount: rows.length, colCount: headers.length },
    "Starting sheet write",
  );

  // Step 1: Get or create the tab
  const sheetId = await getOrCreateTab(sheets, spreadsheetId, tabName);

  // Step 2: Clear existing data and resize grid to fit new data
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${tabName}'!A:ZZ`,
  });

  // Resize grid to fit data exactly (avoid exceeding 10M cell limit)
  const requiredRows = rows.length + 5; // data + header + timestamp + buffer
  const requiredCols = Math.max(headers.length, 1);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: requiredRows,
                columnCount: requiredCols,
              },
            },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        },
      ],
    },
  });

  log.info({ requiredRows, requiredCols, totalCells: requiredRows * requiredCols }, "Grid resized");

  // Step 3: Write data in chunks (50k rows max per request to avoid payload limits)
  const data2D = to2DArray(headers, rows);
  const CHUNK_SIZE = 50000;

  for (let i = 0; i < data2D.length; i += CHUNK_SIZE) {
    const chunk = data2D.slice(i, i + CHUNK_SIZE);
    const startRow = i + 1; // 1-indexed
    const range = `'${tabName}'!A${startRow}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: chunk },
    });

    log.info(
      {
        chunk: Math.floor(i / CHUNK_SIZE) + 1,
        startRow,
        chunkRows: chunk.length,
      },
      "Chunk written",
    );
  }

  // Step 4: Format headers + set tab color + freeze row
  const formatRequests: sheets_v4.Schema$Request[] = [
    // Bold + blue background + white text on header row
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToColor("1F4E79"),
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    // Freeze header row
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: "gridProperties.frozenRowCount",
      },
    },
  ];

  // Set tab color if provided
  if (colorHex) {
    formatRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          tabColorStyle: { rgbColor: hexToColor(colorHex) },
        },
        fields: "tabColorStyle",
      },
    });
  }

  // Auto-resize columns only if <= 5000 rows (performance)
  if (rows.length <= 5000) {
    formatRequests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: headers.length,
        },
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: formatRequests },
  });

  // Step 5: Write timestamp
  const tz = timeZone || "America/Mexico_City";
  const now = new Date();
  const timestamp = now.toLocaleString("es-MX", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const timestampRow = rows.length + 3; // 2 rows below data (row 1 = header, then data rows, then skip 1)

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A${timestampRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [[`Actualizado: ${timestamp}`]] },
  });

  const durationMs = Date.now() - start;
  log.info(
    { spreadsheetId, tabName, rowsWritten: rows.length, durationMs },
    "Sheet write complete",
  );

  return { rowsWritten: rows.length, durationMs };
}

// Get existing tab's sheetId or create it
async function getOrCreateTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tabName: string,
): Promise<number> {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === tabName,
  );

  if (existing?.properties?.sheetId != null) {
    return existing.properties.sheetId as number;
  }

  // Create the tab
  const addResult = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });

  const newSheetId =
    addResult.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error(`Failed to create tab '${tabName}'`);
  }

  log.info({ spreadsheetId, tabName, sheetId: newSheetId }, "Created new tab");
  return newSheetId;
}
