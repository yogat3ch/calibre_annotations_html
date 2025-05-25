import json
import os
import re
from urllib.parse import unquote

def _read_file_or_return_string(input_data: str) -> str:
    """
    Checks if input_data is a valid file path. If so, reads and returns
    the file content. Otherwise, returns the input string itself.
    """
    # Heuristic: if the input contains newlines, it's likely content, not a path.
    if '\n' in input_data or not os.path.exists(input_data):
        return input_data
    
    try:
        print(f"Attempting to read file: {input_data}")
        # 'utf-8-sig' automatically handles the BOM if present.
        with open(input_data, 'r', encoding='utf-8-sig') as f:
            return f.read()
    except Exception as e:
        print(f"Error reading file {input_data}: {e}. Treating input as string content.")
        return input_data
def sanitize_color(color):
    """
    Extract the hex code from a hexadecimal color
    Args:
        color: A hexadecimal color string (e.g., "#rrggbb").

    Returns:
        The hexadecimal color string with the #.
    """
    return re.sub(r'[^a-zA-Z0-9-]', '', color)
def color_contrasting(hex_color):
    """
    Generates a contrasting hexadecimal color.

    Args:
        hex_color: A hexadecimal color string (e.g., "#rrggbb").

    Returns:
        A contrasting hexadecimal color string.
    """
    hex_color = hex_color.lstrip("#")
    rgb = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    contrasting_rgb = tuple(255 - c for c in rgb)
    contrasting_hex = "#{:02x}{:02x}{:02x}".format(*contrasting_rgb)
    return contrasting_hex

def color_lighten(hex_color, factor=0.5):
    """
    Lightens a given hex color by a specified factor.

    Args:
        hex_color: The hex color code as a string (e.g., "#RRGGBB").
        factor: The lightening factor (0.0-1.0, where 1.0 is fully white).

    Returns:
        A lighter hex color code as a string.
    """
    hex_color = hex_color.lstrip("#")
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)

    r = int(r + (255 - r) * factor)
    g = int(g + (255 - g) * factor)
    b = int(b + (255 - b) * factor)

    return "#{:02x}{:02x}{:02x}".format(r, g, b)

def color_opacity(hex_color, opacity=1.0):
    """
    Adds opacity to a hex color string.

    Args:
        hex_color: Hex color string (e.g., "#RRGGBB" or "RRGGBB").
        opacity: Float between 0.0 (transparent) and 1.0 (opaque).

    Returns:
        Hex color string with alpha channel (e.g., "#RRGGBBAA").
    """
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        # Expand short form (e.g., "abc" -> "aabbcc")
        hex_color = ''.join([c*2 for c in hex_color])
    if len(hex_color) != 6:
        raise ValueError("Invalid hex color format")
    alpha = int(round(opacity * 255))
    return f"#{hex_color}{alpha:02x}"
    
def format_annotations_to_html(json_input: str, markdown_input: str, write_file: str = None) -> str:
    """
    Formats Markdown text by wrapping Calibre annotations with styled HTML blockquotes.

    This function processes Calibre annotations by replacing the Markdown version of a highlight
    with an HTML `<blockquote>` that contains the highlight text from the JSON source, an HTML
    link, and any associated notes. Headers in the original Markdown are preserved.

    Args:
        json_input: A JSON string or a file path to a JSON file containing Calibre annotation data.
        markdown_input: A Markdown string or a file path to a Markdown file.
        write_file: Optional. A file path (e.g., "output/final.md") to write the output to.
                    If provided, the output is written to this file. Ensures .md extension.

    Returns:
        The new HTML/Markdown string with styled annotations and a prepended <style> tag.
    
    Raises:
        ValueError: If JSON parsing fails or the JSON structure is invalid.
    """
    json_annotations_string = _read_file_or_return_string(json_input)
    markdown_string = _read_file_or_return_string(markdown_input)

    if not json_annotations_string.strip():
        raise ValueError("Invalid input: Resolved JSON annotations string is empty.")
    
    try:
        data = json.loads(json_annotations_string)
    except json.JSONDecodeError as e:
        snippet = json_annotations_string[:100]
        raise ValueError(f"Invalid JSON data: {e}. Problem near: \"{snippet}...\"") from e

    json_annotation_list = data.get("annotations")
    if not isinstance(json_annotation_list, list):
        json_annotation_list = data.get("highlights")
    if not isinstance(json_annotation_list, list):
        raise ValueError('Invalid JSON structure: "annotations" array not found.')

    cfi_to_annotation_map = {}
    used_colors = set()

    for ann in json_annotation_list:
        if ann.get("start_cfi") and isinstance(ann.get("spine_index"), int):
            # The CFI key is constructed as it appears in the decoded Calibre link.
            cfi_key = f"/{ (ann['spine_index'] * 2) + 2 }{ ann['start_cfi'] }"
            cfi_to_annotation_map[cfi_key] = ann
            if ann.get("style") and ann["style"].get("which"):
                used_colors.add(ann["style"]["which"])

    # Split markdown by '---' delimiter, keeping the delimiter for reconstruction
    rgx_split_delim = r'(\n-{3,}\n)'
    markdown_parts = re.split(rgx_split_delim, markdown_string)
    new_markdown_parts = []
    
    # Regex to find the calibre link and extract its text and URL
    link_regex = re.compile(r'\[(.*?)\]\((calibre:\/\/.*?open_at=epubcfi%28(.*?)%29)\)')

    for part in markdown_parts:
        if re.search(rgx_split_delim, part):
            new_markdown_parts.append(part)
            continue
        
        link_match = link_regex.search(part)
        
        if not link_match:
            new_markdown_parts.append(part)
            continue

        try:
            # The URL-encoded CFI part is the 3rd capture group
            cfi_in_link_decoded = unquote(link_match.group(3))
        except Exception as e:
            print(f"Could not decode CFI from link: {link_match.group(2)}. Error: {e}")
            new_markdown_parts.append(part)
            continue
            
        json_annotation = cfi_to_annotation_map.get(cfi_in_link_decoded)

        if not json_annotation:
            new_markdown_parts.append(part)
            continue
        
        # --- Annotation found, now reconstruct the content ---
        
        # 1. Separate headers from the main content and convert Markdown headers to HTML
        prefix_content = ""
        annotation_content_to_replace = part
        lines = part.split('\n')
        first_non_header_line_idx = 0
        for i, line in enumerate(lines):
            line_trimmed = line.strip()
            if line_trimmed.startswith('#'):
                # Count number of leading hashes for header level
                header_match = re.match(r'^(#+)\s*(.*)', line_trimmed)
                if header_match:
                    header_level = min(len(header_match.group(1)), 6)
                    header_text = header_match.group(2)
                    prefix_content += f"<h{header_level}>{header_text}</h{header_level}>\n"
                first_non_header_line_idx = i + 1
            elif line_trimmed == "" and prefix_content:
                prefix_content += '\n'
                first_non_header_line_idx = i + 1
            elif line_trimmed != "":
                break # First non-empty, non-header line
            else: # Empty line before any real content
                prefix_content += '\n'
                first_non_header_line_idx = i + 1
        
        annotation_content_to_replace = '\n'.join(lines[first_non_header_line_idx:])
        
        # 2. Build the blockquote
        color = json_annotation.get("style", {}).get("which", "default")
        json_highlighted_text = json_annotation.get("highlighted_text", "")
        
        # Convert Markdown link to HTML <a> tag
        link_text = link_match.group(1)
        link_url = link_match.group(2)
        html_link = f'<a href="{link_url}">{link_text}</a>'
        
        # Process note
        note_for_blockquote = ""
        original_md_link_str = link_match.group(0)
        note_section_in_md = annotation_content_to_replace.split(original_md_link_str, 1)[-1]
        
        leading_ws_for_note = re.match(r'^\s*', note_section_in_md).group(0)
        actual_md_note_text = note_section_in_md.lstrip()
        
        json_note = json_annotation.get("notes", "")
        if json_note and json_note.strip() != "" and actual_md_note_text.strip() != "":
            note_for_blockquote = f"{leading_ws_for_note}<em>Note: </em>{actual_md_note_text}"
        elif actual_md_note_text.strip() != "":
            note_for_blockquote = note_section_in_md

        # Assemble blockquote content
        blockquote_inner_content = f"{json_highlighted_text}\n{html_link}"
        if note_for_blockquote.strip():
            blockquote_inner_content += ('\n' if not note_for_blockquote.startswith('\n') else '') + note_for_blockquote.rstrip()
            
        blockquote_html = f'<blockquote class="bq-{color}">\n{blockquote_inner_content}\n</blockquote>'
        
        # Add the prefix (headers) and the new blockquote
        new_markdown_parts.append(prefix_content.rstrip() + ('\n\n' if prefix_content.strip() else '') + blockquote_html)

    final_markdown = "".join(new_markdown_parts)

    # Prepend CSS styles
    style_lines = ["<style>", "/* Calibre Annotation Styles */"]
    if not used_colors and cfi_to_annotation_map:
        used_colors.add("default")
        
    for color in sorted(list(used_colors)): # Sort for consistent output
        sanitized_color = re.sub(r'[^a-zA-Z0-9-]', '', color)
        if not sanitized_color: continue
        
        border_color = sanitized_color if sanitized_color != "default" else "#cccccc"
        bg_colors = {"yellow": "#fff9c4", "blue": "#e3f2fd", "green": "#e8f5e9", "red": "#ffebee", "default": "#f9f9f9"}
        link_colors = {"yellow": "#795548", "blue": "#0d47a1", "green": "#1b5e20", "red": "#b71c1c", "default": "#333333"}
        
        bg_color = bg_colors.get(sanitized_color, "#f5f5f5")
        link_color = link_colors.get(sanitized_color, "#333333")
        
        style_lines.extend([
            f".bq-{sanitized_color} {{",
            f"  border-left: 3px solid {border_color} !important;",
            f"  padding: 0.5em 10px;",
            f"  margin: 1em 0;",
            f"  background-color: {bg_color};",
            f"  border-radius: 4px;",
            f"}}",
            f".bq-{sanitized_color} a {{",
            f"  color: {link_color};",
            f"  font-weight: bold;",
            f"}}",
            f".bq-{sanitized_color} em {{",
            f"  font-style: italic;",
            f"  font-weight: bold;",
            f"  color: {link_color};",
            f"}}"
        ])
    style_lines.append("</style>\n")
    final_output_string = "\n".join(style_lines) + "\n" + final_markdown
    # Replace all lines matching `rgx_split_delim` with <hr> tags
    final_output_string = re.sub(rgx_split_delim, "\n<hr>\n", final_output_string)
    # Write to file if path is provided
    if write_file and isinstance(write_file, str) and write_file.strip():
        output_path = write_file.strip()
        dir_name, file_name = os.path.split(output_path)
        file_base, file_ext = os.path.splitext(file_name)

        if file_ext.lower() != ".html":
            output_path = os.path.join(dir_name, file_base + ".html")

        try:
            if dir_name:
                os.makedirs(dir_name, exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(final_output_string)
            print(f"Output successfully written to: {output_path}")
        except Exception as e:
            print(f"Error writing output to file {output_path}: {e}")

    return final_output_string

# Example usage:
if __name__ == '__main__':
    # These paths are examples. You would replace them with your actual file paths.
    json_file_path = 'annotations_2025-05-09.json'
    markdown_file_path = 'annotations_2025-05-09.md'
    output_file_path = 'output/annotations_styled.html'

    print("--- Running Python Annotation Formatter ---")
    
    # Check if example files exist before running
    if os.path.exists(json_file_path) and os.path.exists(markdown_file_path):
        try:
            # Call the function with file paths and specify an output file
            formatted_html = format_annotations_to_html(json_file_path, markdown_file_path, write_file=output_file_path)
            
            # The function also returns the string, so you can use it directly
            # print("\n--- Generated HTML (first 1000 chars) ---")
            # print(formatted_html[:1000] + "...")
            
        except ValueError as e:
            print(f"\nAn error occurred: {e}")
    else:
        print("\nSkipping example: Could not find one or both input files.")
        print(f"Please ensure '{json_file_path}' and '{markdown_file_path}' exist.")

