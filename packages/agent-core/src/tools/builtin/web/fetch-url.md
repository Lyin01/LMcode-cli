Fetch content from a URL. Returns the main text content extracted from the page. Use this when you need to read a specific web page.

Only public `http`/`https` URLs are supported. Private, loopback and link-local addresses are refused unless the host runs in unrestricted mode (`LMCODE_UNRESTRICTED`); responses larger than 10 MiB are rejected only outside that mode.
