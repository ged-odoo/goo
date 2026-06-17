import odoo
import odoo.tools
from odoo import http
from odoo.http import request


class DevTools(http.Controller):
    @http.route('/dev/autologin', type='http', auth='none', csrf=False)
    def autologin(self, to='/web/tests', **kwargs):
        """Dev-only: create an admin session and redirect. Only works with --dev=all."""
        admin = request.env(su=True).ref('base.user_admin')
        request.session.uid = admin.id
        request.session.login = admin.login
        request.session.db = request.db
        request.session.session_token = admin._compute_session_token(request.session.sid)

        return request.redirect(to)
