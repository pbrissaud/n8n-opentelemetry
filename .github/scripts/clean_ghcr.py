import requests
import os
import time

TOKEN = os.getenv("GITHUB_TOKEN") 
OWNER = os.getenv("REPO").split('/')[0] 
PACKAGE_NAME = os.getenv("REPO").split('/')[1] 

PACKAGE_TYPE = "container" 

API_URL = "https://api.github.com"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
}

def get_untagged_versions():
    """
    Fetches all package versions and filters for untagged ones.
    Handles pagination to process all 900+ images.
    """
    print(f"Fetching versions for {OWNER}/{PACKAGE_NAME} ({PACKAGE_TYPE})...")
    
    # Endpoint depends on whether it's an Org or a User
    # Assuming Org based on 'n8n-io', change to /users/ if it's a personal account
    url = f"{API_URL}/orgs/{OWNER}/packages/{PACKAGE_TYPE}/{PACKAGE_NAME}/versions"
    
    # If it's a personal user, uncomment this line instead:
    # url = f"{API_URL}/users/{OWNER}/packages/{PACKAGE_TYPE}/{PACKAGE_NAME}/versions"

    params = {
        "per_page": 100,
        "state": "active"
    }
    
    untagged_list = []
    page = 1
    
    while True:
        try:
            print(f"Reading page {page}...")
            response = requests.get(url, headers=HEADERS, params=params)
            response.raise_for_status()
            versions = response.json()
            
            if not versions:
                break
            
            for v in versions:
                # The crucial check: tags array is empty
                tags = v.get("metadata", {}).get("container", {}).get("tags", [])
                
                # Check if tags list is empty
                if not tags:
                    untagged_list.append(v['id'])
            
            # Check for next page in Link header
            if 'next' not in response.links:
                break
                
            page += 1
            # Little pause to be nice to the API
            params['page'] = page
            
        except Exception as e:
            print(f"Error fetching versions: {e}")
            break
            
    return untagged_list

def delete_version(version_id):
    """
    Deletes a specific package version by ID.
    """
    url = f"{API_URL}/orgs/{OWNER}/packages/{PACKAGE_TYPE}/{PACKAGE_NAME}/versions/{version_id}"
    # If personal user:
    # url = f"{API_URL}/users/{OWNER}/packages/{PACKAGE_TYPE}/{PACKAGE_NAME}/versions/{version_id}"

    if DRY_RUN:
        print(f"[DRY RUN] Would delete version ID: {version_id}")
        return True

    try:
        response = requests.delete(url, headers=HEADERS)
        response.raise_for_status()
        print(f"[SUCCESS] Deleted version ID: {version_id}")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to delete version {version_id}: {e}")
        return False

if __name__ == "__main__":
    if not TOKEN:
        print("Error: GITHUB_TOKEN environment variable is missing.")
        exit(1)

    print(f"--- Starting Cleanup ---")
    
    untagged_ids = get_untagged_versions()
    
    count = len(untagged_ids)
    print(f"Found {count} untagged versions.")
    
    if count == 0:
        print("Nothing to clean. Exiting.")
        exit(0)

    print("Starting deletion process...")
    
    deleted_count = 0
    for vid in untagged_ids:
        if delete_version(vid):
            deleted_count += 1
            time.sleep(0.5)

    print(f"--- Finished ---")
    print(f"Total processed: {deleted_count}/{count}")
