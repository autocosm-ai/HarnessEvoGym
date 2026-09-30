FROM python:3.11-slim

WORKDIR /workspace

RUN useradd -m -u 1000 agent && \
    chown -R agent:agent /workspace

USER agent

CMD ["/bin/bash"]
