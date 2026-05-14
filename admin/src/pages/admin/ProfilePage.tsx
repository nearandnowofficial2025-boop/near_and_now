import { useState, useEffect } from 'react';
import { Mail, Phone, Shield, Edit, Calendar, Clock, CheckCircle, Lock, Star, Activity } from 'lucide-react';
import { getCurrentAdmin } from '../../services/secureAdminAuth';
import { getAdminClient } from '../../services/supabase';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/layout/AdminLayout';

const PERMISSION_LABELS: Record<string, string> = {
  'products:read': 'View Products',
  'products:write': 'Edit Products',
  'products:delete': 'Delete Products',
  'orders:read': 'View Orders',
  'orders:update': 'Update Orders',
  'customers:read': 'View Customers',
  'customers:write': 'Edit Customers',
  'admins:read': 'View Admins',
  'admins:write': 'Manage Admins',
  'reports:read': 'View Reports',
  'settings:write': 'Edit Settings',
};

const PERMISSION_COLORS: Record<string, string> = {
  'products': 'bg-blue-100 text-blue-700',
  'orders': 'bg-emerald-100 text-emerald-700',
  'customers': 'bg-violet-100 text-violet-700',
  'admins': 'bg-red-100 text-red-700',
  'reports': 'bg-amber-100 text-amber-700',
  'settings': 'bg-slate-100 text-slate-700',
};

function getPermColor(perm: string) {
  const resource = perm.split(':')[0];
  return PERMISSION_COLORS[resource] || 'bg-gray-100 text-gray-700';
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const ProfilePage = () => {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    const currentAdmin = getCurrentAdmin();
    setAdmin(currentAdmin);

    if (currentAdmin?.id) {
      getAdminClient()
        .from('admin_sessions')
        .select('id, created_at, expires_at, logged_out_at')
        .eq('admin_id', currentAdmin.id)
        .is('logged_out_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(5)
        .then(({ data }) => {
          setSessions(data || []);
          setSessionsLoading(false);
        });
    } else {
      setSessionsLoading(false);
    }
  }, []);

  if (!admin) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <div className="w-10 h-10 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </AdminLayout>
    );
  }

  const initials = admin.full_name
    ? admin.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : (admin.email || 'A').charAt(0).toUpperCase();

  const permissions: string[] = Array.isArray(admin.permissions)
    ? admin.permissions
    : typeof admin.permissions === 'object' && admin.permissions !== null
    ? Object.entries(admin.permissions)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k)
    : [];

  const isSuperAdmin = admin.role === 'super_admin';

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-5xl">
        {/* Banner + Avatar */}
        <div className="relative rounded-2xl overflow-hidden shadow-sm">
          <div className="h-36 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />
          <div className="bg-white px-6 pb-6">
            <div className="flex items-end justify-between -mt-12">
              <div className="flex items-end gap-4">
                <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg ring-4 ring-white">
                  {initials}
                </div>
                <div className="pb-2">
                  <h1 className="text-2xl font-bold text-gray-900">{admin.full_name || 'Admin User'}</h1>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${isSuperAdmin ? 'bg-gradient-to-r from-amber-100 to-orange-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      {isSuperAdmin ? '★ Super Admin' : 'Admin'}
                    </span>
                    {admin.status === 'active' && (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <CheckCircle size={12} /> Active
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={() => navigate(`/admins/edit/${admin.id}`)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 transition-colors shadow-sm"
              >
                <Edit size={15} />
                Edit Profile
              </button>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Shield, label: 'Role', value: (admin.role || 'admin').replace('_', ' '), color: 'text-emerald-600', bg: 'bg-emerald-50' },
            { icon: Activity, label: 'Status', value: admin.status || 'Active', color: 'text-blue-600', bg: 'bg-blue-50' },
            { icon: Lock, label: 'Permissions', value: isSuperAdmin ? 'Full Access' : `${permissions.length} granted`, color: 'text-violet-600', bg: 'bg-violet-50' },
            { icon: Star, label: 'Sessions', value: sessionsLoading ? '...' : `${sessions.length} active`, color: 'text-amber-600', bg: 'bg-amber-50' },
          ].map(({ icon: Icon, label, value, color, bg }) => (
            <div key={label} className={`rounded-2xl ${bg} p-4 flex items-center gap-3`}>
              <div className={`w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center ${color}`}>
                <Icon size={18} />
              </div>
              <div>
                <p className="text-xs text-gray-500 font-medium">{label}</p>
                <p className={`text-sm font-bold capitalize ${color}`}>{value}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Contact Info */}
          <div className="lg:col-span-2 rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Contact Information</h2>
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-3 rounded-xl bg-gray-50">
                <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                  <Mail size={16} />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Email Address</p>
                  <p className="text-sm font-semibold text-gray-800">{admin.email || 'N/A'}</p>
                </div>
              </div>

              {admin.phone ? (
                <div className="flex items-center gap-4 p-3 rounded-xl bg-gray-50">
                  <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-600">
                    <Phone size={16} />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 font-medium">Phone Number</p>
                    <p className="text-sm font-semibold text-gray-800">{admin.phone}</p>
                  </div>
                </div>
              ) : null}

              {admin.created_at ? (
                <div className="flex items-center gap-4 p-3 rounded-xl bg-gray-50">
                  <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center text-violet-600">
                    <Calendar size={16} />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 font-medium">Member Since</p>
                    <p className="text-sm font-semibold text-gray-800">{formatDate(admin.created_at)}</p>
                  </div>
                </div>
              ) : null}

              {admin.last_login ? (
                <div className="flex items-center gap-4 p-3 rounded-xl bg-gray-50">
                  <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center text-amber-600">
                    <Clock size={16} />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 font-medium">Last Login</p>
                    <p className="text-sm font-semibold text-gray-800">{timeAgo(admin.last_login)}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Active Sessions */}
          <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Active Sessions</h2>
            {sessionsLoading ? (
              <div className="flex items-center justify-center h-24">
                <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-6">
                <Clock size={28} className="text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No active sessions</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sessions.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-emerald-50">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-700">
                        {i === 0 ? 'Current session' : `Session ${i + 1}`}
                      </p>
                      <p className="text-[10px] text-gray-400">{timeAgo(s.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Permissions */}
        {(isSuperAdmin || permissions.length > 0) && (
          <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Permissions</h2>
            {isSuperAdmin ? (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200">
                <Star size={20} className="text-amber-500" />
                <div>
                  <p className="text-sm font-bold text-amber-800">Full System Access</p>
                  <p className="text-xs text-amber-600">Super admins have unrestricted access to all features</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {permissions.map(perm => (
                  <span key={perm} className={`text-xs font-semibold px-3 py-1.5 rounded-full ${getPermColor(perm)}`}>
                    {PERMISSION_LABELS[perm] || perm}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
};

export default ProfilePage;
