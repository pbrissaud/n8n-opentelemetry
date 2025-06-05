import requests
import os

GITHUB_API = "https://api.github.com/repos/n8n-io/n8n/releases"
CI_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'workflows', 'ci.yaml')

def get_latest_releases():
    releases = requests.get(GITHUB_API).json()
    stable = [r for r in releases if not r.get('prerelease') and not r.get('draft')]
    return [r['tag_name'].lstrip('v').replace('n8n@', '') for r in stable[:3]]

def update_matrix_text(latest_versions):
    with open(CI_FILE, 'r') as f:
        lines = f.readlines()
    new_lines = []
    in_matrix = False
    in_versions = False
    indent = ''
    for line in lines:
        if not in_matrix and 'n8n-version:' in line:
            in_matrix = True
            in_versions = True
            indent = line[:line.find('n8n-version:')]
            new_lines.append(line)
            continue
        if in_matrix and in_versions:
            # Remplacer toutes les anciennes versions par les nouvelles
            # On détecte la fin de la liste par une ligne qui n'est plus indentée après la clé
            if line.strip().startswith('- '):
                continue  # skip old versions
            elif line.strip() == '' or line.startswith(indent + ' '):
                continue  # skip blank or still indented lines
            else:
                # On a fini la liste, on insère les nouvelles et on reprend le flux normal
                for v in latest_versions:
                    new_lines.append(f"{indent}  - '{v}'\n")
                in_versions = False
                in_matrix = False
        if not in_versions:
            new_lines.append(line)
    # Si la liste était à la fin du fichier
    if in_matrix and in_versions:
        for v in latest_versions:
            new_lines.append(f"{indent}  - '{v}'\n")
    with open(CI_FILE, 'w') as f:
        f.writelines(new_lines)
    print(f"Updated matrix to: {latest_versions}")

if __name__ == "__main__":
    latest = get_latest_releases()
    update_matrix_text(latest)
