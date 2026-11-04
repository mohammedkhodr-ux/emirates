import argparse
import os

from app.server import make_server


def main():
    parser = argparse.ArgumentParser(description="Emirates live and historical flight tracker")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    server = make_server(args.host, args.port)
    print("Emirates Flight Tracker running at http://%s:%d" % (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
