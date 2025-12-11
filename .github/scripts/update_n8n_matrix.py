import requests
import os
import re

# Request 100 releases to ensure we go back far enough in history to find v1 versions
GITHUB_API = "https://api.github.com/repos/n8n-io/n8n/releases?per_page=100"
CI_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'workflows', 'ci.yaml')

def get_latest_releases():
    try:
        response = requests.get(GITHUB_API)
        response.raise_for_status()
        releases = response.json()
    except Exception as e:
        print(f"Error calling GitHub API: {e}")
        return []

    # Filter to keep only stable releases (no drafts, no prereleases)
    stable = [r for r in releases if not r.get('prerelease') and not r.get('draft')]
    
    clean_versions = []
    for r in stable:
        tag = r['tag_name']
        # Specific cleanup for n8n tags (sometimes 'n8n@1.0.0', sometimes '1.0.0')
        clean_v = tag.replace('n8n@', '').lstrip('v')
        # Validate that it looks like a version number (x.x.x)
        if re.match(r'^\d+\.\d+\.\d+$', clean_v):
            clean_versions.append(clean_v)

    # Key function for semantic sorting (converts '1.10.0' to [1, 10, 0])
    def version_key(v):
        return [int(x) for x in v.split('.')]

    # Split by major versions
    v1_list = [v for v in clean_versions if v.startswith('1.')]
    v2_list = [v for v in clean_versions if v.startswith('2.')]

    # Sort descending (newest to oldest) using semantic keys
    v1_sorted = sorted(list(set(v1_list)), key=version_key, reverse=True)
    v2_sorted = sorted(list(set(v2_list)), key=version_key, reverse=True)

    # Select the top 3 versions for each major version
    top_v2 = v2_sorted[:3]
    top_v1 = v1_sorted[:3]

    print(f"Selected v2 versions: {top_v2}")
    print(f"Selected v1 versions: {top_v1}")

    # Combine lists
    final_selection = top_v2 + top_v1
    
    # Global sort to ensure the YAML list looks clean (descending order)
    final_selection.sort(key=version_key, reverse=True)

    return final_selection

def update_matrix_text(latest_versions):
    if not latest_versions:
        print("No versions found, aborting.")
        return

    # Check if file exists
    if not os.path.exists(CI_FILE):
        print(f"Error: File not found at {CI_FILE}")
        return

    with open(CI_FILE, 'r') as f:
        lines = f.readlines()
    
    new_lines = []
    in_matrix = False
    in_versions = False
    indent = ''
    
    iterator = iter(lines)
    for line in iterator:
        # Detect start of the n8n-version matrix
        if 'n8n-version:' in line and not in_versions:
            in_matrix = True
            in_versions = True
            # Capture the exact indentation of the key
            indent = line.split('n8n-version:')[0]
            new_lines.append(line)
            continue
        
        if in_versions:
            stripped = line.strip()
            # Skip existing version lines
            if stripped.startswith('- '):
                continue 
            
            # Detect end of list: empty line or indentation change
            current_indent = line[:len(line) - len(line.lstrip())]
            is_end_of_list = False
            
            # If line is not empty and indentation is <= key indentation, list is over
            if stripped and (len(current_indent) <= len(indent)):
                is_end_of_list = True

            if is_end_of_list:
                # Inject new versions
                for v in latest_versions:
                    # Assuming standard YAML list indentation (2 spaces from key)
                    new_lines.append(f"{indent}  - '{v}'\n")
                
                in_versions = False
                in_matrix = False
                new_lines.append(line) # Append the current line that triggered the end
            else:
                # Ignore empty lines or comments strictly inside the list
                pass
        else:
            new_lines.append(line)

    # Edge case: If the version list is at the very end of the file
    if in_versions:
        for v in latest_versions:
            new_lines.append(f"{indent}  - '{v}'\n")

    # Write changes back to file
    with open(CI_FILE, 'w') as f:
        f.writelines(new_lines)
    
    print(f"Successfully updated matrix in {CI_FILE} with: {latest_versions}")

if __name__ == "__main__":
    latest = get_latest_releases()
    update_matrix_text(latest)
