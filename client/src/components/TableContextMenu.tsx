import { useState } from 'react';
import './TableContextMenu.css';

interface TableStatus {
  tableId: string;
  tableNumber: number;
  status: 'empty' | 'occupied' | 'reserved' | 'dirty';
  guestCount?: number;
  orderId?: string;
  orderTotal?: number;
  occupiedSince?: number;
  itemsReady?: number;
  itemsPending?: number;
}

interface TableContextMenuProps {
  table: TableStatus;
  restaurantId: string;
  isOpen: boolean;
  onClose: () => void;
  onStatusChange: (tableId: string, newStatus: string) => void;
}

const STATUS_LABELS = {
  empty: 'Empty',
  occupied: 'Occupied',
  reserved: 'Reserved',
  dirty: 'Dirty',
};

export default function TableContextMenu({
  table,
  restaurantId,
  isOpen,
  onClose,
  onStatusChange,
}: TableContextMenuProps) {
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleStatusChange = async (newStatus: string) => {
    setLoading(true);
    try {
      // Call the status update endpoint
      // Send status both in JSON body and query-string as a safety net (some proxies/envs drop POST bodies).
      const response = await fetch(
        `/api/tables/${restaurantId}/${table.tableId}/status?status=${encodeURIComponent(newStatus)}`,
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus }),
        },
      );

      if (response.ok) {
        onStatusChange(table.tableId, newStatus);
        onClose();
      } else {
        const text = await response.text();
        console.error('Status update failed:', response.status, response.statusText, text);

        let errorMsg = `Status ${response.status}`;
        try {
          const json = JSON.parse(text);
          errorMsg = json.error || errorMsg;
        } catch {
          // Response is not JSON, use status text
          errorMsg = response.statusText || errorMsg;
        }

        alert(`❌ Failed to update table status: ${errorMsg}`);
      }
    } catch (err) {
      console.error('Failed to update table status:', err);
      alert(`❌ Error updating table status: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Table {table.tableNumber}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="table-info-section">
            <h3>Current Status</h3>
            <div className="status-badge" style={{ color: getStatusColor(table.status) }}>
              {STATUS_LABELS[table.status as keyof typeof STATUS_LABELS]}
            </div>
          </div>

          {table.status === 'occupied' && (
            <div className="order-info-section">
              <h3>Order Details</h3>
              <div className="info-row">
                <span className="label">Guests:</span>
                <span className="value">{table.guestCount || '—'}</span>
              </div>
              <div className="info-row">
                <span className="label">Items Pending:</span>
                <span className="value">{table.itemsPending || 0}</span>
              </div>
              <div className="info-row">
                <span className="label">Items Ready:</span>
                <span className="value">{table.itemsReady || 0}</span>
              </div>
              <div className="info-row">
                <span className="label">Total:</span>
                <span className="value">₪{(table.orderTotal || 0).toFixed(0)}</span>
              </div>
            </div>
          )}

          <div className="actions-section">
            <h3>Actions</h3>
            <div className="actions">
              {table.status !== 'dirty' && (
                <button
                  className="action-btn btn-mark-dirty"
                  onClick={() => handleStatusChange('dirty')}
                  disabled={loading}
                >
                  🧹 Mark Dirty
                </button>
              )}

              {table.status !== 'reserved' && (
                <button
                  className="action-btn btn-reserve"
                  onClick={() => handleStatusChange('reserved')}
                  disabled={loading}
                >
                  📅 Reserve
                </button>
              )}

              {table.status !== 'empty' && (
                <button
                  className="action-btn btn-empty"
                  onClick={() => handleStatusChange('empty')}
                  disabled={loading}
                >
                  ✔ Clear Table
                </button>
              )}

              {table.status === 'occupied' && (
                <button
                  className="action-btn btn-view-order"
                  onClick={() => {
                    // Navigate to order view
                    window.location.href = `/waiter/${restaurantId}/${table.tableNumber}`;
                  }}
                  disabled={loading}
                >
                  📋 View Order
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'empty':
      return '#4CAF50'; // Green
    case 'occupied':
      return '#FF6B6B'; // Red
    case 'reserved':
      return '#FFC107'; // Orange
    case 'dirty':
      return '#9C27B0'; // Purple
    default:
      return '#333';
  }
}
