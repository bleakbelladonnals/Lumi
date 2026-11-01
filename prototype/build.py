# Builds prototype/index.html: inlines the app's stylesheet and mock data so the file opens with a double-click.
import json, pathlib
root = pathlib.Path(__file__).resolve().parent
app = root.parent / 'app'
src = (root / 'src.html').read_text()
css = (app / 'public' / 'style.css').read_text()
data = json.loads((app / 'data' / 'merchant.json').read_text())
out = src.replace('/*STYLE*/', css).replace('/*DATA*/', json.dumps(data, ensure_ascii=False))
(root / 'index.html').write_text(out)
print('wrote', root / 'index.html', len(out), 'bytes')
