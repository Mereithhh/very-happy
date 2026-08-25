# Fork pull-request isolation smoke

This temporary branch verifies that pull requests from a real fork execute only
on GitHub-hosted runners with read-only repository contents and without access
to deployment, package-publishing, or production resources.
