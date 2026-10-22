"""No Gazebo/ROS imports or processes without explicit FH_SIM_RUN=1."""
from .config import Settings
from .api import create_app


def main():
    import uvicorn
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, workers=1, access_log=False)


if __name__ == '__main__':
    main()
