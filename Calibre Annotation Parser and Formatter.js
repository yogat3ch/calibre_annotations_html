/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Calibre Annotation Parser and Formatter
 *
 * This script provides functions to parse and format annotations exported
 * from the Calibre ebook reader. It can accept input as strings or file paths
 * when running in a Node.js environment.
 *
 * @version 0.3.5
 */

// Import 'fs' and 'path' modules only if in a Node.js environment
let fs;
let path;
if (typeof require !== "undefined") {
  try {
    fs = require("fs");
    path = require("path"); // For path manipulation when writing files
  } catch (e) {
    console.warn(
      "Node.js 'fs' and/or 'path' module not available. File operations will be limited."
    );
    if (!fs) fs = null;
    if (!path) path = null;
  }
} else {
  console.warn(
    "Not in a Node.js environment. File operations will not be available."
  );
  fs = null;
  path = null;
}

/**
 * Helper function to check if a string might be a file path and read it.
 * @param {string} inputString - The input string (potentially a path).
 * @param {string} expectedExtension - The expected file extension (e.g., '.json', '.md').
 * @returns {string} The file content if read successfully, otherwise the original inputString.
 */
function readFileContentOrReturnString(inputString, expectedExtension) {
  const looksLikePath =
    typeof inputString === "string" &&
    inputString.trim().endsWith(expectedExtension) &&
    !inputString.includes("\n");

  if (looksLikePath && fs) {
    try {
      if (fs.existsSync(inputString)) {
        console.log(`Attempting to read file: ${inputString}`);
        return fs.readFileSync(inputString, "utf8");
      } else {
        console.warn(
          `File path specified but not found: ${inputString}. Treating input as string content.`
        );
        return inputString;
      }
    } catch (e) {
      console.error(
        `Error reading file ${inputString}: ${e.message}. Treating input as string content.`
      );
      return inputString;
    }
  }
  return inputString;
}

/**
 * Combines Calibre Highlight Markdown with Calibre annotations to create HTML with blockquotes styled by color,
 * and prepends "Note: " to notes if present. Headers are preserved outside blockquotes.
 * Accepts either raw strings or file paths for Calibre Annotations (JSON) and Markdown input.
 * Optionally writes the output to a specified file path.
 *
 * @param {string} jsonInput - A JSON string OR a file path to a JSON file containing Calibre annotation data.
 * @param {string} markdownInput - The original Markdown string OR a file path to a Markdown file.
 * @param {string} [writeFile=null] - Optional. A file path (e.g., "output/final.md") to write the output to.
 * If provided, the output is written to this file. Ensures .md extension.
 * @returns {string} The new Markdown string with styled annotations and a prepended <style> tag.
 * @throws {Error} If JSON parsing fails or resolved input strings are invalid.
 */
function formatAnnotationsToHTML(jsonInput, markdownInput, writeFile = null) {
  let jsonAnnotationsString = readFileContentOrReturnString(jsonInput, ".json");
  const markdownString = readFileContentOrReturnString(markdownInput, ".md");

  if (
    typeof jsonAnnotationsString !== "string" ||
    jsonAnnotationsString.trim() === ""
  ) {
    throw new Error(
      "Invalid input: Resolved JSON annotations string is empty or not a string."
    );
  }
  if (typeof markdownString !== "string") {
    throw new Error("Invalid input: Resolved Markdown string is not a string.");
  }

  if (jsonAnnotationsString.charCodeAt(0) === 0xfeff) {
    // Check for BOM
    console.log("Byte Order Mark (BOM) detected in JSON input. Removing it.");
    jsonAnnotationsString = jsonAnnotationsString.substring(1);
  }

  let jsonData;
  try {
    jsonData = JSON.parse(jsonAnnotationsString);
  } catch (e) {
    const snippet = jsonAnnotationsString.substring(0, 100);
    throw new Error(
      `Invalid JSON data: ${e.message}. Problem near: "${snippet}..."`
    );
  }

  const jsonAnnotationList = jsonData.annotations;
  if (!Array.isArray(jsonAnnotationList)) {
    throw new Error('Invalid JSON structure: "annotations" array not found.');
  }

  const cfiToAnnotationMap = new Map();
  const usedColors = new Set();

  // Populate map from CFI to the full annotation object
  for (const ann of jsonAnnotationList) {
    if (ann.start_cfi && typeof ann.spine_index === "number") {
      const cfiKeyInMarkdownLink = `/${ann.spine_index * 2 + 2}${
        ann.start_cfi
      }`;
      cfiToAnnotationMap.set(cfiKeyInMarkdownLink, ann);
      if (ann.style && ann.style.which) {
        usedColors.add(ann.style.which);
      }
    }
  }

  const markdownParts = markdownString.split(/(\n---{3,}\n)/); // Split by '---' delimiter
  const newMarkdownParts = [];

  for (let i = 0; i < markdownParts.length; i++) {
    let currentPart = markdownParts[i];

    if (/(\n---{3,}\n)/.test(currentPart)) {
      // Replace markdown separator with <hr>
      newMarkdownParts.push("<hr>\n");
      continue;
    }

    // Try to find a Calibre link in the current part
    const linkMatch = currentPart.match(
      /\[.*?\]\(calibre:\/\/.*?open_at=epubcfi%28(.*?)%29\)/
    );

    if (linkMatch && linkMatch[1]) {
      const cfiInLinkEncoded = linkMatch[1];
      let cfiInLinkDecoded;
      try {
        cfiInLinkDecoded = decodeURIComponent(cfiInLinkEncoded);
      } catch (e) {
        console.warn(`Could not decode CFI: ${cfiInLinkEncoded}`, e);
        newMarkdownParts.push(currentPart); // Push original part if decoding fails
        continue;
      }

      const jsonAnnotation = cfiToAnnotationMap.get(cfiInLinkDecoded);

      if (jsonAnnotation) {
        let prefixContent = ""; // For headers or text before the annotation block
        let annotationContentToReplace = currentPart; // Assume the whole part is the annotation initially

        // Separate headers from the beginning of the currentPart
        const lines = currentPart.split("\n");
        let firstNonHeaderLineIdx = 0;
        for (let j = 0; j < lines.length; j++) {
          const lineTrimmed = lines[j].trim();
          if (lineTrimmed.startsWith("#")) {
            prefixContent += lines[j] + "\n";
            firstNonHeaderLineIdx = j + 1;
          } else if (lineTrimmed === "" && prefixContent !== "") {
            // Allow empty lines after headers
            prefixContent += lines[j] + "\n";
            firstNonHeaderLineIdx = j + 1;
          } else if (lineTrimmed !== "") {
            // First non-empty, non-header line
            break;
          } else {
            // Empty line before any content, potentially part of annotation block's top margin
            prefixContent += lines[j] + "\n";
            firstNonHeaderLineIdx = j + 1;
          }
        }
        // The part of the currentPart that is potentially the annotation (MD highlight, link, MD note)
        annotationContentToReplace = lines
          .slice(firstNonHeaderLineIdx)
          .join("\n");

        // Re-check linkMatch within this specific annotationContentToReplace,
        // as its indices would be relative to this substring.
        const linkMatchInAnnotationContent = annotationContentToReplace.match(
          /\[(.*?)\]\((calibre:\/\/.*?open_at=epubcfi%28.*?%29)\)/
        );

        if (
          !linkMatchInAnnotationContent ||
          linkMatchInAnnotationContent.length < 3
        ) {
          // Link not found or not parsed correctly
          newMarkdownParts.push(currentPart); // Push original part
          continue;
        }

        const color = jsonAnnotation.style?.which || "default";
        const jsonHighlightedText = jsonAnnotation.highlighted_text || ""; // Use empty string if undefined

        // Extract link text and URL from the Markdown link
        const linkText = linkMatchInAnnotationContent[1];
        const linkUrl = linkMatchInAnnotationContent[2];
        const htmlLink = `<a href="${linkUrl}">${linkText}</a>`;

        let noteForBlockquote = "";
        // Find the position of the original Markdown link string to get text after it
        const originalMarkdownLinkString = linkMatchInAnnotationContent[0];
        const textAfterLinkInAnnotationContent =
          annotationContentToReplace.substring(
            annotationContentToReplace.indexOf(originalMarkdownLinkString) +
              originalMarkdownLinkString.length
          );

        const leadingWhitespaceForNote =
          textAfterLinkInAnnotationContent.match(/^\s*/)[0] || "";
        const actualMarkdownNoteText =
          textAfterLinkInAnnotationContent.trimStart();

        if (
          jsonAnnotation.notes &&
          jsonAnnotation.notes.trim() !== "" &&
          actualMarkdownNoteText.trim() !== ""
        ) {
          noteForBlockquote =
            leadingWhitespaceForNote +
            "<br><em>Note: </em>" +
            actualMarkdownNoteText;
        } else if (actualMarkdownNoteText.trim() !== "") {
          noteForBlockquote = leadingWhitespaceForNote + actualMarkdownNoteText;
        }
        noteForBlockquote = noteForBlockquote.trimEnd(); // Trim trailing space from the note itself

        // Construct the blockquote content
        let blockquoteInnerContent = jsonHighlightedText;
        blockquoteInnerContent += "\n" + htmlLink; // Use the generated HTML link
        if (noteForBlockquote) {
          blockquoteInnerContent +=
            (noteForBlockquote.startsWith("\n") ? "" : "\n") +
            noteForBlockquote;
        }

        const blockquoteHTML = `<blockquote class="bq-${color}">\n${blockquoteInnerContent.trim()}\n</blockquote>`;

        const trimmedOriginalPart = currentPart.trim();
        const trimmedAnnotationContent = annotationContentToReplace.trim();

        if (trimmedOriginalPart === trimmedAnnotationContent) {
          newMarkdownParts.push(
            prefixContent.trimEnd() +
              (prefixContent ? "\n" : "") +
              blockquoteHTML
          );
        } else {
          newMarkdownParts.push(
            prefixContent.trimEnd() +
              (prefixContent.trimEnd() ? "\n\n" : "") +
              blockquoteHTML
          );
        }
      } else {
        newMarkdownParts.push(currentPart);
      }
    } else {
      newMarkdownParts.push(currentPart);
    }
  }

  let finalMarkdown = newMarkdownParts.join("");

  // Replace any remaining markdown separators (in case of edge cases) with <hr>
  finalMarkdown = finalMarkdown.replace(/\n---{3,}\n/g, "<hr>\n");

  // Replace markdown headers with HTML header tags
  // This will replace lines starting with 1-6 '#' followed by a space and text
  finalMarkdown = finalMarkdown.replace(
    /^([ \t]*)(#{1,6})[ \t]+(.+?)\s*$/gm,
    (match, leading, hashes, text) => {
      const level = hashes.length;
      return `${leading}<h${level}>${text.trim()}</h${level}>`;
    }
  );

  let styles = "<style>\n";
  styles += "/* Calibre Annotation Styles */\n";
  if (usedColors.size === 0 && cfiToAnnotationMap.size > 0) {
    usedColors.add("default");
  }

  usedColors.forEach((color) => {
    const sanitizedColor = String(color).replace(/[^a-zA-Z0-9\-]/g, "");
    if (sanitizedColor) {
      const actualBorderColor =
        sanitizedColor === "default" ? "#cccccc" : sanitizedColor;
      const actualBgColor =
        sanitizedColor === "yellow"
          ? "#fff9c4"
          : sanitizedColor === "blue"
          ? "#e3f2fd"
          : sanitizedColor === "green"
          ? "#e8f5e9"
          : sanitizedColor === "red"
          ? "#ffebee"
          : sanitizedColor === "default"
          ? "#f9f9f9"
          : "#f5f5f5";
      const actualLinkColor =
        sanitizedColor === "yellow"
          ? "#795548"
          : sanitizedColor === "blue"
          ? "#0d47a1"
          : sanitizedColor === "green"
          ? "#1b5e20"
          : sanitizedColor === "red"
          ? "#b71c1c"
          : sanitizedColor === "default"
          ? "#333333"
          : "#333";

      styles += `.bq-${sanitizedColor} {\n`;
      styles += `  border-left: 3px solid ${actualBorderColor} !important;\n`;
      styles += `  padding: 0.5em 10px;\n`;
      styles += `  margin: 1em 0;\n`;
      styles += `  background-color: ${actualBgColor};\n`;
      styles += `  border-radius: 4px;\n`;
      styles += `}\n`;
      styles += `.bq-${sanitizedColor} a {\n`;
      styles += `  color: ${actualLinkColor};\n`;
      styles += `  font-weight: bold;\n`;
      styles += `}\n`;
      styles += `.bq-${sanitizedColor} em {\n`;
      styles += `  font-style: italic;\n`;
      styles += `  font-weight: bold;\n`;
      styles += `  color: ${actualLinkColor};\n`;
      styles += `}\n`;
    }
  });
  styles += "</style>\n\n";

  const finalOutputString = styles + finalMarkdown;

  if (
    writeFile &&
    typeof writeFile === "string" &&
    writeFile.trim() !== "" &&
    fs &&
    path
  ) {
    let outputPath = writeFile.trim();
    const dir = path.dirname(outputPath);
    let filename = path.basename(outputPath);
    const ext = path.extname(filename);

    if (ext.toLowerCase() !== ".html") {
      filename =
        (ext === ""
          ? filename
          : filename.substring(0, filename.length - ext.length)) + ".html";
    }
    outputPath = path.join(dir, filename);

    try {
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
      fs.writeFileSync(outputPath, finalOutputString, "utf8");
      console.log(`Output successfully written to: ${outputPath}`);
    } catch (e) {
      console.error(`Error writing output to file ${outputPath}: ${e.message}`);
    }
  }

  return finalOutputString;
}

/**
 * Example Usage for formatAnnotationsToMarkdown:
 */
function exampleFormatter() {
  const sampleJsonString = `{
    "annotations": [
        { "book_id": 3, "spine_index": 4, "start_cfi": "/2/4/8/1:235", "style": {"which": "yellow"}, "highlighted_text": "...", "notes": "..." },
        { "book_id": 3, "spine_index": 5, "start_cfi": "/2/4/46/1:450", "style": {"which": "blue"}, "highlighted_text": "...", "notes": "" },
        { "book_id": 3, "spine_index": 7, "start_cfi": "/2/4/12/1:0", "style": {"which": "green"}, "highlighted_text": "...", "notes": "..." }
    ], "type": "calibre_annotation_collection", "version": 1
  }`;

  const sampleMarkdownString = `
# My Book Annotations

## Preface
---
“If you want to understand your mind, sit down and observe it.”
[5/3/25 8:45 PM](calibre://view-book/_hex_-426f6f6b73/3/EPUB?open_at=epubcfi%28/10/2/4/8/1%3A235%29)
Anagārika Munindra
---
## Introduction
---
Maybe when the Buddha repeats certain phrases...
[5/3/25 8:54 PM](calibre://view-book/_hex_-426f6f6b73/3/EPUB?open_at=epubcfi%28/12/2/4/46/1%3A450%29)
---
### Chapter 1 Section
---
What are the four? Here, bhikkhus...
[5/3/25 8:55 PM](calibre://view-book/_hex_-426f6f6b73/3/EPUB?open_at=epubcfi%28/16/2/4/12/1%3A0%29)
The Four Foundations
---
`;

  console.log("--- Running Example with String Literals ---");
  try {
    // Simulate BOM for string literal test
    const jsonWithBOM = "\uFEFF" + sampleJsonString;
    const formattedMarkdown = formatAnnotationsToHTML(
      jsonWithBOM,
      sampleMarkdownString
    );
    console.log(
      "Formatted Markdown Output:\n",
      formattedMarkdown.substring(0, 500) + "..."
    );
  } catch (error) {
    console.error("Error in formatter example (strings):", error.message);
  }

  const jsonFilePath = "./annotations_2025-05-09.json";
  const markdownFilePath = "./annotations_2025-05-09.md";

  console.log(
    "\n--- Running Example with File Paths (Requires Node.js & Files) ---"
  );
  if (fs) {
    if (fs.existsSync(jsonFilePath) && fs.existsSync(markdownFilePath)) {
      try {
        const formattedMarkdownFromFile = formatAnnotationsToHTML(
          jsonFilePath,
          markdownFilePath
        );
        console.log(
          "Formatted Markdown Output (from files):\n",
          formattedMarkdownFromFile
        );
      } catch (error) {
        console.error("Error in formatter example (files):", error.message);
      }
    } else {
      console.log(
        `Skipping file path example: One or both files not found ('${jsonFilePath}', '${markdownFilePath}')`
      );
    }
  } else {
    console.log(
      "Skipping file path example: Not running in Node.js or 'fs' module unavailable."
    );
  }
  // Example of writing to a file (Only works in Node.js with fs/path available)
  if (fs && path) {
    console.log(
      "\n--- Running Example with String Literals (Output to File) ---"
    );
    const outputFilePath = "./example_output.md"; // Define a path for the output file
    const outputFilePathNoExt = "./example_output_no_ext";
    const outputFilePathWrongExt = "./example_output_wrong_ext.txt";

    try {
      const jsonToTest = "\uFEFF" + sampleJsonString;
      // Test writing to a file with .md extension
      formatAnnotationsToHTML(jsonToTest, sampleMarkdownString, outputFilePath);
      // Test writing to a file with no extension (should add .md)
      formatAnnotationsToHTML(
        jsonToTest,
        sampleMarkdownString,
        outputFilePathNoExt
      );
      // Test writing to a file with .txt extension (should change to .md)
      formatAnnotationsToHTML(
        jsonToTest,
        sampleMarkdownString,
        outputFilePathWrongExt
      );

      console.log(
        `\nCheck for files: ${outputFilePath}, ${outputFilePathNoExt}.md, and ${outputFilePathWrongExt.replace(
          ".txt",
          ".md"
        )}`
      );
    } catch (error) {
      console.error("Error in formatter example (file output):", error.message);
    }
  } else {
    console.log(
      "\nSkipping file output example: Not running in Node.js or fs/path modules unavailable."
    );
  }
}

if (typeof require !== "undefined" && require.main === module) {
  //exampleFormatter();
  formatAnnotationsToHTML(
    "/Users/stephenholsenbeck/Documents/Buddhism/Dharma Teacher Training/Reading Notes/Mindfulness by Joseph Goldstein/annotations_2025-05-13.json",
    "/Users/stephenholsenbeck/Documents/Buddhism/Dharma Teacher Training/Reading Notes/Mindfulness by Joseph Goldstein/annotations_2025-05-13.md",
    "./output/annotations_output.html"
  );
}

// module.exports = { parseCalibreAnnotationsCSV, formatAnnotationsToMarkdown }; // CommonJS
