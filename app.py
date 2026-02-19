from flask import Flask

app = Flask(__name__, static_folder='static', static_url_path='/static')

@app.route('/')
def index():
    return 'Karaokee is running'

if __name__ == '__main__':
    app.run(debug=True, port=5000)
