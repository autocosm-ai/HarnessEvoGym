FROM python:3.11-slim

WORKDIR /tests

COPY test.sh /tests/

RUN chmod +x /tests/test.sh

CMD ["/bin/bash", "/tests/test.sh"]
