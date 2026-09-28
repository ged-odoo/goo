"""Docker-managed global services for launch_mode="docker" workspaces."""

import os
from typing import Any


def resolve_docker_image(
    branch: str, docker_images: list[dict[str, Any]] | None
) -> dict[str, Any] | None:
    """The Docker image row matching `branch`'s Odoo version — the first row
    whose `versions` prefixes match (plain branch.startswith(prefix), mirroring
    oe.fish's `switch $OdooVersion { case "16.0*" "17.0*": ... }`), else the row
    marked is_default, else None (no image configured for this version, and no
    fallback set)."""
    for row in docker_images or []:
        if any(branch.startswith(p) for p in row.get("versions") or []):
            return row
    return next((r for r in docker_images or [] if r.get("is_default")), None)


class DockerInfraService:
    """The Docker-managed "global services" a launch_mode="docker" workspace
    needs before it can start: a shared network, a Postgres container, and an
    nginx reverse proxy routing <container>.localhost by Docker's own embedded
    DNS (the goo-managed counterpart to backend/adopt.py's read-only detection,
    which stays for launch_mode="external"). Each ensure_* is idempotent — safe
    to call before every workspace start; a caller doing several in a row
    (WorkspaceManager.start) should run them before taking any of its own
    locks, since docker build/pull can take minutes."""

    def __init__(self, io: Any, nginx_conf_path: str) -> None:
        self.io = io
        self.nginx_conf_path = nginx_conf_path

    def ensure_network(self, name: str) -> tuple[bool, str | None]:
        """Create the shared Docker network if it doesn't exist yet. Returns
        (ok, error)."""
        r = self.io.run(["docker", "network", "inspect", name], quiet=True, timeout=10)
        if r.returncode == 0:
            return True, None
        r = self.io.run(["docker", "network", "create", name], timeout=15)
        if r.returncode != 0:
            return False, r.stderr.strip() or "docker network create failed"
        return True, None

    def _container_status(self, name: str) -> str:
        """ "running" | "stopped" | "missing" for a container name."""
        r = self.io.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", name], quiet=True, timeout=10
        )
        if r.returncode != 0:
            return "missing"
        return "running" if r.stdout.strip() == "true" else "stopped"

    def ensure_postgres(self, config: dict[str, Any]) -> tuple[bool, str | None]:
        """Idempotently get the Docker-managed Postgres container running,
        creating it (with db_user/db_password — the same credentials goo's own
        psql access already uses) on first call. Returns (ok, error)."""
        name = config.get("docker_postgres_container") or "goo-postgres"
        status = self._container_status(name)
        if status == "running":
            return True, None
        if status == "stopped":
            r = self.io.run(["docker", "start", name], timeout=15)
            if r.returncode != 0:
                return False, r.stderr.strip() or "docker start (postgres) failed"
            return True, None
        network = config.get("docker_network") or "goo_odoo"
        image = config.get("docker_postgres_image") or "postgres:16"
        port = config.get("docker_postgres_port") or "5433"
        volume = config.get("docker_postgres_volume") or "goo-postgres-data"
        user = config.get("db_user") or "odoo"
        password = config.get("db_password") or "odoo"
        r = self.io.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                network,
                "-e",
                f"POSTGRES_USER={user}",
                "-e",
                f"POSTGRES_PASSWORD={password}",
                "-p",
                f"127.0.0.1:{port}:5432",
                "-v",
                f"{volume}:/var/lib/postgresql/data",
                image,
            ],
            timeout=60,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "docker run (postgres) failed"
        return True, None

    # a single static template — the "route by container name, no fixed port
    # table" trick never varies per user, so goo generates it rather than
    # asking every user to hand-maintain their own nginx.conf
    _NGINX_CONF = (
        "events {}\n"
        "http {\n"
        "    resolver 127.0.0.11 valid=10s;\n"
        "    server {\n"
        "        listen 80;\n"
        "        server_name ~^(?<name>.+)\\.localhost$;\n"
        "        location / {\n"
        "            set $upstream $name;\n"
        "            proxy_pass http://$upstream:8069;\n"
        "            proxy_set_header Host $host;\n"
        "            proxy_set_header X-Real-IP $remote_addr;\n"
        "            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "            proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        }\n"
        "    }\n"
        "}\n"
    )

    def ensure_nginx(self, config: dict[str, Any]) -> tuple[bool, str | None]:
        """Idempotently get the goo-generated nginx reverse proxy running. The
        config file is (re)written every call so a settings change (network,
        nginx_port) takes effect on the container's next (re)start; an already-
        running container isn't restarted just because the file changed
        underneath it — nginx doesn't hot-reload it either way without a signal
        goo doesn't send, so a config change only takes effect after a manual
        stop/start of the nginx container. Returns (ok, error)."""
        ok, err = self.io.write_text(self.nginx_conf_path, self._NGINX_CONF)
        if not ok:
            return False, err
        name = config.get("docker_nginx_container") or "goo-nginx"
        status = self._container_status(name)
        if status == "running":
            return True, None
        if status == "stopped":
            r = self.io.run(["docker", "start", name], timeout=15)
            if r.returncode != 0:
                return False, r.stderr.strip() or "docker start (nginx) failed"
            return True, None
        network = config.get("docker_network") or "goo_odoo"
        image = config.get("docker_nginx_image") or "nginx:alpine"
        port = config.get("docker_nginx_port") or "80"
        r = self.io.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                network,
                "-p",
                f"{port}:80",
                "-v",
                f"{self.nginx_conf_path}:/etc/nginx/nginx.conf:ro",
                image,
            ],
            timeout=30,
        )
        if r.returncode != 0:
            return False, r.stderr.strip() or "docker run (nginx) failed"
        return True, None

    def ensure_image(self, config: dict[str, Any], branch: str) -> tuple[str | None, str | None]:
        """Resolve the Docker image for `branch` (resolve_docker_image); build
        it from its Dockerfile on demand if the tag isn't present locally yet
        (mirroring oe.fish's own "build the missing image" step). Returns
        (image_tag, error)."""
        row = resolve_docker_image(branch, config.get("docker_images") or [])
        if row is None:
            return (
                None,
                "no Docker image configured for this Odoo version, and no default image set",
            )
        tag = row.get("image") or f"goo-{row.get('id') or row.get('label') or 'odoo'}"
        r = self.io.run(["docker", "image", "inspect", tag], quiet=True, timeout=10)
        if r.returncode == 0:
            return tag, None
        dockerfile = row.get("dockerfile_path")
        if not dockerfile:
            return None, f'Docker image "{tag}" isn\'t built locally, and no Dockerfile path is set'
        path = os.path.expanduser(dockerfile)
        context_dir = os.path.dirname(path) or "."
        r = self.io.run(["docker", "build", "-t", tag, "-f", path, context_dir], timeout=1800)
        if r.returncode != 0:
            return None, r.stderr.strip() or "docker build failed"
        return tag, None

    def next_container_slot(self) -> str | None:
        """The next free "dev", "dev1", "dev2", ... container name — an
        anonymous pool of slots (order of starting decides the number),
        NOT a fixed name per workspace: the same workspace can land on a
        different slot every start, whichever is free at the time. Reachable
        at http://<slot>.localhost/ (nginx). Checked with `docker container
        inspect`, not `docker ps`, so a not-yet-removed stopped container
        still claims its slot. Called after ensure_network/ensure_postgres, so
        docker itself is already confirmed reachable. Returns the name, or
        None past a sanity cap (1000 slots — far more concurrent dev servers
        than one machine runs)."""
        name = "dev"
        slot = 0
        for _ in range(1000):
            r = self.io.run(["docker", "container", "inspect", name], quiet=True, timeout=10)
            if r.returncode != 0:
                return name
            slot += 1
            name = f"dev{slot}"
        return None
