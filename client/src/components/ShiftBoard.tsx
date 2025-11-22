import { useState, useEffect } from 'react';
import './ShiftBoard.css';

interface StaffMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status: string;
}

interface ShiftAssignment {
  id: string;
  staffId: string;
  staffName: string;
  staffRole: string;
  date: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'checked_in' | 'checked_out' | 'called_out' | 'cancelled';
  checkedInAt?: number;
  checkedOutAt?: number;
}

interface ShiftBoardProps {
  restaurantId: string;
}

const ROLE_COLORS: Record<string, string> = {
  waiter: '#FF6B6B',
  chef: '#4ECDC4',
  manager: '#FFE66D',
  busser: '#95E1D3',
  host: '#C7B3E5',
  bartender: '#F38181',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#E8F5E9',
  checked_in: '#C8E6C9',
  checked_out: '#BDBDBD',
  called_out: '#FFE0B2',
  cancelled: '#FFCDD2',
};

export default function ShiftBoard({ restaurantId }: ShiftBoardProps) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<ShiftAssignment[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(false);
  const [showAddStaffForm, setShowAddStaffForm] = useState(false);
  const [showAddShiftForm, setShowAddShiftForm] = useState(false);
  const [newStaff, setNewStaff] = useState({ firstName: '', lastName: '', email: '', role: 'waiter', userId: '' });
  const [newShift, setNewShift] = useState({ staffId: '', startTime: '09:00', endTime: '17:00' });

  useEffect(() => {
    loadData();
  }, [selectedDate, restaurantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [staffRes, shiftsRes] = await Promise.all([
        fetch(`/api/restaurants/${restaurantId}/staff`),
        fetch(`/api/restaurants/${restaurantId}/shifts?date=${selectedDate}`),
      ]);

      if (staffRes.ok) setStaff(await staffRes.json());
      if (shiftsRes.ok) setShifts(await shiftsRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddStaff = async () => {
    if (!newStaff.firstName || !newStaff.lastName || !newStaff.email) {
      alert('Please fill in required fields');
      return;
    }

    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newStaff,
          userId: newStaff.userId || crypto.randomUUID(),
        }),
      });

      if (res.ok) {
        await loadData();
        setNewStaff({ firstName: '', lastName: '', email: '', role: 'waiter', userId: '' });
        setShowAddStaffForm(false);
      }
    } catch (err) {
      console.error('Failed to add staff:', err);
    }
  };

  const handleAddShift = async () => {
    if (!newShift.staffId) {
      alert('Please select a staff member');
      return;
    }

    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffId: newShift.staffId,
          date: selectedDate,
          startTime: newShift.startTime,
          endTime: newShift.endTime,
        }),
      });

      if (res.ok) {
        await loadData();
        setNewShift({ staffId: '', startTime: '09:00', endTime: '17:00' });
        setShowAddShiftForm(false);
      }
    } catch (err) {
      console.error('Failed to add shift:', err);
    }
  };

  const handleCheckIn = async (shiftId: string) => {
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (res.ok) await loadData();
    } catch (err) {
      console.error('Failed to check in:', err);
    }
  };

  const handleCheckOut = async (shiftId: string) => {
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}/check-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (res.ok) await loadData();
    } catch (err) {
      console.error('Failed to check out:', err);
    }
  };

  const handleCancelShift = async (shiftId: string) => {
    if (confirm('Cancel this shift?')) {
      try {
        const res = await fetch(`/api/restaurants/${restaurantId}/shifts/${shiftId}`, {
          method: 'DELETE',
        });

        if (res.ok) await loadData();
      } catch (err) {
        console.error('Failed to cancel shift:', err);
      }
    }
  };

  const timeToMinutes = (time: string): number => {
    const [hours, mins] = time.split(':').map(Number);
    return hours * 60 + mins;
  };

  const minutesToTime = (mins: number): string => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const getStaffName = (staffId: string) => {
    const s = staff.find(m => m.id === staffId);
    return s ? `${s.firstName} ${s.lastName}` : 'Unknown';
  };

  const previousDate = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  };

  const nextDate = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  };

  // Generate time slots (9am to 11pm)
  const timeSlots = Array.from({ length: 15 }, (_, i) => {
    const hour = 9 + i;
    return { hour, time: `${String(hour).padStart(2, '0')}:00` };
  });

  const DAY_START = 9 * 60; // 9am in minutes
  const DAY_END = 23 * 60; // 11pm in minutes

  return (
    <div className="shift-board">
      <header className="board-header">
        <h1>📅 Shift Board</h1>
        <div className="date-controls">
          <button onClick={previousDate}>← Previous</button>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="date-picker"
          />
          <button onClick={nextDate}>Next →</button>
        </div>
      </header>

      {loading && <div className="loading">Loading...</div>}

      <div className="board-container">
        {/* Left Sidebar - Staff List */}
        <div className="staff-sidebar">
          <div className="staff-header">
            <h2>Staff ({staff.length})</h2>
            <button className="btn-add" onClick={() => setShowAddStaffForm(!showAddStaffForm)}>
              {showAddStaffForm ? '✕' : '+'}
            </button>
          </div>

          {showAddStaffForm && (
            <div className="form-card">
              <input
                type="text"
                placeholder="First name"
                value={newStaff.firstName}
                onChange={(e) => setNewStaff({ ...newStaff, firstName: e.target.value })}
              />
              <input
                type="text"
                placeholder="Last name"
                value={newStaff.lastName}
                onChange={(e) => setNewStaff({ ...newStaff, lastName: e.target.value })}
              />
              <input
                type="email"
                placeholder="Email"
                value={newStaff.email}
                onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
              />
              <select
                value={newStaff.role}
                onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })}
              >
                <option value="waiter">Waiter</option>
                <option value="chef">Chef</option>
                <option value="manager">Manager</option>
                <option value="busser">Busser</option>
                <option value="host">Host</option>
                <option value="bartender">Bartender</option>
              </select>
              <button className="btn-primary" onClick={handleAddStaff}>Add Staff</button>
            </div>
          )}

          <div className="staff-list">
            {staff.map((s) => (
              <div
                key={s.id}
                className="staff-card"
                style={{ borderLeftColor: ROLE_COLORS[s.role] || '#999' }}
              >
                <div className="staff-info">
                  <strong>{s.firstName} {s.lastName}</strong>
                  <small>{s.role}</small>
                </div>
                <span className="status-badge" style={{ backgroundColor: ROLE_COLORS[s.role] || '#999' }}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Main Timeline */}
        <div className="timeline-container">
          {/* Time Header */}
          <div className="time-header">
            <div className="staff-col-header"></div>
            <div className="timeline-header">
              {timeSlots.map((slot) => (
                <div key={slot.time} className="time-slot-header">
                  {slot.time}
                </div>
              ))}
            </div>
          </div>

          {/* Staff Rows with Shift Bars */}
          <div className="timeline-rows">
            {staff.length === 0 ? (
              <div className="empty-state">No staff members. Add one to get started!</div>
            ) : (
              staff.map((s) => {
                const staffShifts = shifts.filter(sh => sh.staffId === s.id);
                return (
                  <div key={s.id} className="staff-row">
                    <div className="staff-name-col">{s.firstName}</div>
                    <div className="shifts-timeline">
                      {/* Background grid */}
                      {timeSlots.map((slot) => (
                        <div key={slot.time} className="time-cell"></div>
                      ))}

                      {/* Shift bars */}
                      {staffShifts.map((shift) => {
                        const startMins = timeToMinutes(shift.startTime);
                        const endMins = timeToMinutes(shift.endTime);
                        const offsetLeft = ((startMins - DAY_START) / (DAY_END - DAY_START)) * 100;
                        const width = ((endMins - startMins) / (DAY_END - DAY_START)) * 100;

                        return (
                          <div
                            key={shift.id}
                            className={`shift-bar shift-${shift.status}`}
                            style={{
                              left: `${offsetLeft}%`,
                              width: `${width}%`,
                              backgroundColor: ROLE_COLORS[shift.staffRole] || '#999',
                              borderColor: STATUS_COLORS[shift.status] || '#ccc',
                            }}
                            title={`${shift.startTime}-${shift.endTime}`}
                          >
                            <div className="shift-bar-inner">
                              <span className="time-text">
                                {shift.startTime}
                              </span>
                              {shift.status === 'checked_in' && (
                                <span className="check-in-badge">✓</span>
                              )}
                            </div>

                            {/* Action buttons */}
                            <div className="shift-actions">
                              {shift.status === 'scheduled' && (
                                <button
                                  className="btn-action check-in"
                                  onClick={() => handleCheckIn(shift.id)}
                                  title="Check In"
                                >
                                  ✓
                                </button>
                              )}
                              {shift.status === 'checked_in' && (
                                <button
                                  className="btn-action check-out"
                                  onClick={() => handleCheckOut(shift.id)}
                                  title="Check Out"
                                >
                                  ✗
                                </button>
                              )}
                              {shift.status !== 'checked_out' && shift.status !== 'cancelled' && (
                                <button
                                  className="btn-action cancel"
                                  onClick={() => handleCancelShift(shift.id)}
                                  title="Cancel"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Sidebar - Actions */}
        <div className="actions-sidebar">
          <div className="actions-header">
            <h2>Schedule</h2>
            <button className="btn-add" onClick={() => setShowAddShiftForm(!showAddShiftForm)}>
              {showAddShiftForm ? '✕' : '+'}
            </button>
          </div>

          {showAddShiftForm && (
            <div className="form-card">
              <label>Select Staff</label>
              <select
                value={newShift.staffId}
                onChange={(e) => setNewShift({ ...newShift, staffId: e.target.value })}
              >
                <option value="">-- Choose --</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.firstName} {s.lastName} ({s.role})
                  </option>
                ))}
              </select>

              <label>Start</label>
              <input
                type="time"
                value={newShift.startTime}
                onChange={(e) => setNewShift({ ...newShift, startTime: e.target.value })}
              />

              <label>End</label>
              <input
                type="time"
                value={newShift.endTime}
                onChange={(e) => setNewShift({ ...newShift, endTime: e.target.value })}
              />

              <button className="btn-primary" onClick={handleAddShift}>
                Schedule Shift
              </button>
            </div>
          )}

          {/* Coverage Summary */}
          <div className="coverage-card">
            <h3>Today's Coverage</h3>
            <div className="coverage-stats">
              <div className="stat">
                <span className="stat-label">Total Shifts:</span>
                <span className="stat-value">{shifts.length}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Checked In:</span>
                <span className="stat-value">{shifts.filter(s => s.status === 'checked_in').length}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Scheduled:</span>
                <span className="stat-value">{shifts.filter(s => s.status === 'scheduled').length}</span>
              </div>
            </div>

            {/* Role breakdown */}
            <div className="role-breakdown">
              {Object.entries(ROLE_COLORS).map(([role, color]) => {
                const count = shifts.filter(s => s.staffRole === role).length;
                return count > 0 ? (
                  <div key={role} className="role-stat">
                    <span
                      className="role-dot"
                      style={{ backgroundColor: color }}
                    ></span>
                    <span>{role} ({count})</span>
                  </div>
                ) : null;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
