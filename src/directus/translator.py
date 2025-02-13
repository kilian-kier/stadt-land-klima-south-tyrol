import os
import yaml
import requests

def translate_text(text, api_key, source_lang='DE', target_lang='IT'):
    url = 'https://api-free.deepl.com/v2/translate'
    params = {
        'auth_key': api_key,
        'text': text,
        'source_lang': source_lang,
        'target_lang': target_lang
    }
    response = requests.post(url, data=params)
    result = response.json()
    return result['translations'][0]['text']

directory = './translations'

api_key = '' # Insert your Deepl API key here

for filename in os.listdir(directory):
    if 'de-DE' in filename and filename.endswith('.yaml'):
        file_path = os.path.join(directory, filename)

        with open(file_path, 'r', encoding='utf-8') as file:
            content = yaml.safe_load(file)

        if 'value' in content:
            original_text = content['value']
            translated_text = translate_text(original_text, api_key)
            content['value'] = translated_text

        if 'language' in content:
            content['language'] = 'it-IT'

        new_filename = filename.replace('de-DE', 'it-IT')
        new_file_path = os.path.join(directory, new_filename)

        with open(new_file_path, 'w', encoding='utf-8') as new_file:
            yaml.dump(content, new_file, allow_unicode=True)

        print(f'Translated {filename} to {new_filename}')
